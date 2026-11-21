import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { runCrawl, type CrawlProgress, type StopReason } from "./engine.js";
import { analyzePages, computeSummary } from "../analysis/analyze.js";
import { normalizeHost } from "./url.js";
import { assertSafeStartUrl, SsrfBlockedError } from "./ssrf.js";

export class StartCrawlValidationError extends Error {}

// 別のクロールが実行中のため新規開始できないことを表すエラー（ルート側で 409 に変換する）
export class CrawlAlreadyRunningError extends Error {
  constructor(public readonly runningId: string) {
    super("別のクロールが実行中です。完了するか中止してから、もう一度開始してください。");
    this.name = "CrawlAlreadyRunningError";
  }
}

type ProgressEvent =
  | { type: "progress"; data: CrawlProgress }
  | { type: "done"; data: { id: string; truncated: boolean; stopReason: StopReason | null } }
  | { type: "error"; data: { message: string } };

export const crawlEvents = new EventEmitter();
// crawlEvents は「クロールID = イベント名」としたチャンネル方式で進捗を配信する
// (routes/crawls.ts の SSE ハンドラが crawlEvents.on(id, ...) で購読し、
//  接続終了時に crawlEvents.off(id, ...) で確実に解除している)。
// そのため通常は1チャンネルあたり1〜数リスナー(同一クロールを複数タブで開いた場合)に留まり、
// デフォルト上限(10)で十分間に合うはずだが、将来的に同一クロールを多数のクライアントが
// 同時購読するケースを考慮し、デフォルトの警告閾値を緩めるために明示的な上限を設定する。
// 0(無制限)にするとリスナー解除漏れ(本来のリーク)の検知も無効化されてしまうため、
// 想定される最大同時購読数より十分大きい固定値を設定して検知能力を残す。
crawlEvents.setMaxListeners(50);

// 実行中のクロール（開始受付〜DB 保存完了まで）。同時に実行できるクロールは1本だけで、
// このマップが「実行中かどうか」の唯一の判定根拠になる（DB の status は参照しない）。
// 大規模サイトのクロールはメモリを大きく使うため、1プロセスで複数本を並行させると
// ヒープ上限・コンテナの RAM 上限を超えやすい。待ち行列は作らず、実行中は新規開始を拒否する。
interface RunningCrawl {
  // キャンセル API から取得フェーズを中断するためのコントローラ
  controller: AbortController;
  // 取得フェーズ（runCrawl 実行中）か。保存フェーズに入った後の中止要求は受け付けるが何もしない
  // （取得はもう終わっており、保存を途中で止めると結果が残らないため）
  fetching: boolean;
}
const running = new Map<string, RunningCrawl>();

// 実行枠を確保する。チェックと登録を同期的に（間に await を挟まずに）行うことで、
// 同時に届いた開始リクエストが両方ともチェックを通過してしまう競合を防ぐ。
function reserveSlot(id: string): RunningCrawl {
  const current = running.keys().next();
  if (!current.done) throw new CrawlAlreadyRunningError(current.value);
  const slot: RunningCrawl = { controller: new AbortController(), fetching: true };
  running.set(id, slot);
  return slot;
}

// 実行中のクロールの ID（無ければ null）
export function getRunningCrawlId(): string | null {
  const current = running.keys().next();
  return current.done ? null : current.value;
}

// クロール結果の DB 書き込みチャンクサイズ（1回の createMany に渡す行数）。
// 1回あたりのデータを Prisma エンジンへの1リクエストとして数百KB程度に抑えるための値。
// SQLite のバインド変数上限（Prisma の SQLite コネクタは 999 を前提に扱う）を超える分は
// Prisma が1回の createMany 内で複数の INSERT 文に自動分割するため、ここでは上限に合わせる必要はない。
// （Page は 18 列 → 500 行で 9,000 変数、Edge は 4 列 → 2,000 行で 8,000 変数、CrawlError は 3 列）
const PAGE_CHUNK = 500;
const EDGE_CHUNK = 2000;
const ERROR_CHUNK = 500;

// チャンク間でイベントループへ制御を返し、書き込み中も HTTP リクエストや SSE を処理できるようにする
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// items を先頭から size 件ずつ取り出して書き込む。書き終えたチャンクの参照を残さないよう
// items 自体を破壊的に消費する（呼び出し後 items は空配列になる）。
async function writeInChunks<T>(items: T[], size: number, write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  while (items.length) {
    const chunk = items.splice(0, size);
    await write(chunk);
    await yieldToEventLoop();
  }
}

// エラーメッセージを1行に要約する。Prisma のエラーは先頭行が「Invalid `prisma.x()` invocation」で
// 実際の理由が末尾行にあるため、複数行の場合は先頭行と末尾行をつなげる。
function firstLine(v: unknown): string {
  const lines = String(v ?? "").split("\n").map((s) => s.trim()).filter((s) => s);
  if (!lines.length) return "";
  const text = lines.length === 1 ? lines[0] : `${lines[0]} … ${lines[lines.length - 1]}`;
  return text.slice(0, 500);
}

function memoryStat(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  return `rssMB=${mb(m.rss)} heapUsedMB=${mb(m.heapUsed)} externalMB=${mb(m.external)}`;
}

// 指定クロールの子テーブルの行（Page / Edge / CrawlError）を削除する
async function deleteCrawlRows(crawlIds: string | string[]): Promise<void> {
  const where = typeof crawlIds === "string" ? { crawlId: crawlIds } : { crawlId: { in: crawlIds } };
  await prisma.edge.deleteMany({ where });
  await prisma.page.deleteMany({ where });
  await prisma.crawlError.deleteMany({ where });
}

export function newCrawlId(): string {
  return "cr_" + randomBytes(3).toString("hex");
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

// サーバー起動時に「実行中」のまま残っているクロールを「エラー」へ訂正する。
// 通常クロールは executeCrawl の catch でエラー状態を記録するが、
// メモリ枯渇によるプロセスクラッシュ(OOM/Aborted)のようにJSの例外として
// 捕捉できない異常終了の場合はその記録処理自体が走らない。
// 結果としてDB上は status: "running" のまま残り、それを完了させるプロセスも
// 存在しないため永久に「実行中」と表示され続けてしまう。
// この関数はプロセス起動直後(=running setが空、つまり進行中のクロールは
// 存在し得ない時点)に呼び出すことを前提としており、その時点で running/queued の
// クロールは前回プロセスのクラッシュによる孤児だと判断してよい。
export async function recoverOrphanedCrawls(): Promise<void> {
  const orphaned = await prisma.crawl.findMany({
    where: { status: { in: ["running", "queued"] } },
    select: { id: true },
  });
  if (!orphaned.length) return;
  // 結果の DB 書き込みはチャンク単位で行う（トランザクションで包まない）ため、書き込み途中で
  // プロセスが落ちた場合は書きかけの行が残り得る。エラー扱いにするクロールの行は削除しておく。
  await deleteCrawlRows(orphaned.map((c) => c.id));
  await prisma.crawl.updateMany({
    where: { id: { in: orphaned.map((c) => c.id) } },
    data: { status: "error", finishedAt: new Date() },
  });
  for (const { id } of orphaned) {
    console.warn(`[crawl:${id}] 起動時に「実行中」のまま残っていたクロールを「エラー」に訂正しました(前回プロセスの異常終了による孤児と判断)`);
  }
}

export interface StartCrawlInput {
  startUrl: string;
  maxDepth: number;
  label?: string;
}

export async function startCrawl(input: StartCrawlInput): Promise<{ id: string }> {
  // 他のクロールが実行中なら、SSRF 検証や DB 書き込みより前にここで拒否する（CrawlAlreadyRunningError）
  const id = newCrawlId();
  const slot = reserveSlot(id);
  try {
    await prepareCrawl(id, input);
  } catch (err) {
    // 開始に失敗した場合は確保した実行枠を返す
    running.delete(id);
    throw err;
  }
  void executeCrawl(id, slot, { startUrl: input.startUrl, maxDepth: input.maxDepth });
  return { id };
}

// クロール開始前の検証と DB へのクロール行の作成
async function prepareCrawl(id: string, input: StartCrawlInput): Promise<void> {
  // startUrl はルートの startUrlSchema により「http(s) スキーム付きの絶対URL」であることが
  // 既に保証されているため、ここでスキームを補完する必要はない
  // （ユーザーが指定したスキームをそのままクロールに使う。詳しくは engine.ts 参照）。
  const startUrl = input.startUrl;

  // SSRF対策: localhost / プライベートIP / クラウドメタデータ等への接続をクロール開始前に拒否する。
  // （DNSリバインディング対策としては fetcher 側の毎リクエスト再検証が本命だが、
  //   ここで早期に弾くことで明確なエラーをユーザーへ返せる）
  try {
    await assertSafeStartUrl(startUrl);
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw new StartCrawlValidationError(err.message);
    throw err;
  }

  const host = normalizeHost(input.startUrl);

  await prisma.crawl.create({
    data: {
      id,
      host,
      label: input.label?.trim() || host,
      startUrl,
      maxDepth: input.maxDepth,
      status: "queued",
      active: true,
    },
  });
  // 新しいクロールをアクティブにし、他は非アクティブへ。
  // ここで失敗すると呼び出し元は実行枠を返すが、作成済みの行は queued のまま残り、
  // 次回起動の recoverOrphanedCrawls まで「待機中」と表示され続けるため、作成した行を取り消す。
  try {
    await prisma.crawl.updateMany({ where: { id: { not: id } }, data: { active: false } });
  } catch (err) {
    await discardCreatedCrawl(id);
    throw err;
  }
}

// 開始処理の途中で失敗したクロール行を取り消す（削除できなければ error にする）。
// 子テーブルの行はまだ作られていないため、クロール行だけを対象にする。
async function discardCreatedCrawl(id: string): Promise<void> {
  try {
    await prisma.crawl.delete({ where: { id } });
    return;
  } catch (deleteErr: any) {
    console.error(`[crawl:${id}] 開始に失敗したクロール行の削除に失敗しました:`, deleteErr?.message || deleteErr);
  }
  try {
    await prisma.crawl.update({ where: { id }, data: { status: "error", finishedAt: new Date() } });
  } catch (updateErr: any) {
    console.error(`[crawl:${id}] 開始に失敗したクロール行をエラーにできませんでした:`, updateErr?.message || updateErr);
  }
}

// 実行中のクロールの中止を要求する。
//   "cancelling": 取得フェーズ中だったので中断した（それまでの結果を truncated として保存し、done イベントが流れる）
//   "saving"    : 既に取得を終えて保存中のため、そのまま完了させる（done イベントが流れる）
//   null        : このプロセスで実行中のクロールではない
export function cancelCrawl(id: string): "cancelling" | "saving" | null {
  const slot = running.get(id);
  if (!slot) return null;
  if (!slot.fetching) return "saving";
  if (!slot.controller.signal.aborted) {
    console.log(`[crawl:${id}] 中止要求を受け付けました`);
    slot.controller.abort();
  }
  return "cancelling";
}

async function executeCrawl(id: string, slot: RunningCrawl, opts: { startUrl: string; maxDepth: number }) {
  // 失敗時に「どの段階で・どこまで進んで」失敗したかを1行で残すための進捗情報
  const startedAt = Date.now();
  let phase = "start";
  const counts = { pages: 0, pagesWritten: 0, edges: 0, edgesWritten: 0, errorsWritten: 0 };
  try {
    await prisma.crawl.update({ where: { id }, data: { status: "running" } });

    phase = "crawl";
    const result = await runCrawl(
      { startUrl: opts.startUrl, maxDepth: opts.maxDepth, signal: slot.controller.signal },
      (p) => emitProgress(id, p)
    );
    slot.fetching = false;
    counts.pages = result.pages.length;
    counts.edges = result.edgeCount;
    if (result.truncated) {
      // 打ち切り理由（pages/heap/time/cancel）は DB に保存する列が無いためログにのみ残す
      console.warn(
        `[crawl:${id}] TRUNCATED reason=${result.stopReason ?? "unknown"} pages=${counts.pages} edges=${counts.edges}` +
          ` errors=${result.errors.length} elapsedMs=${Date.now() - startedAt} ${memoryStat()}`
      );
    }

    phase = "analyze";
    // analyzePages は edges を参照しない（被リンク数は engine 側で集計済み）ため、
    // edges を配列として実体化せず空配列を渡す
    const analyzed = analyzePages(result.pages, []);
    // analyzed は pages の各要素を複製したものなので、元配列の参照は切っておく
    result.pages = [];
    const summary = computeSummary(analyzed);

    // ---- DB 書き込み ----
    // 以前は全ページ・全 edges・全エラーを1トランザクションの createMany で書き込んでいたが、
    // 大規模サイトでは1回の createMany に数十万〜数百万行が渡り、Prisma の Rust エンジンが
    // V8 ヒープ外に数GBを一時確保して（glibc が OS に返さないため）常駐メモリが階段状に増え続けていた。
    // そのため一定行数ごとのチャンクに分けて順次書き込み、書き終えたチャンクは参照を捨てる。
    // トランザクションで全体を包まない代わりに、crawl.status は最後まで "running" のままにし、
    // 全行の書き込みが終わってから1回の update で "done" にする。途中で失敗した場合は catch 側で
    // 書きかけの行を削除して "error" にする（プロセスごと落ちた場合は recoverOrphanedCrawls が掃除する）。
    // また、以前の対話型 $transaction は既定タイムアウト(5秒)を超えると "Transaction already closed" で
    // 全体がロールバックされ、大規模サイトほど保存に失敗して 0 ページの error になり得た。
    // チャンクごとの createMany は個別の短い文なので、総書き込み時間が長くてもタイムアウトしない。
    phase = "save-cleanup";
    const saveStartedAt = Date.now();
    await deleteCrawlRows(id); // 同一IDに残骸があれば念のため消しておく

    phase = "save-pages";
    await writeInChunks(analyzed, PAGE_CHUNK, async (chunk) => {
      await prisma.page.createMany({
        data: chunk.map((p) => ({
          crawlId: id,
          id: p.id,
          url: p.url,
          status: p.status,
          title: p.title,
          h1: p.h1,
          description: p.description,
          depth: p.depth,
          parent: p.parent,
          inLinks: p.inLinks,
          outLinks: p.outLinks,
          words: p.words,
          size: p.size,
          noindex: p.noindex,
          canonical: p.canonical,
          redirectTo: p.redirectTo ?? null,
          ttfbMs: p.ttfbMs ?? null,
          issues: JSON.stringify(p.issues),
        })),
      });
      counts.pagesWritten += chunk.length;
    });

    phase = "save-edges";
    for (const batch of result.edgeBatches(EDGE_CHUNK)) {
      await prisma.edge.createMany({
        data: batch.map((e) => ({ crawlId: id, s: e.s, t: e.t, type: e.type })),
      });
      counts.edgesWritten += batch.length;
      await yieldToEventLoop();
    }

    phase = "save-errors";
    await writeInChunks(result.errors, ERROR_CHUNK, async (chunk) => {
      await prisma.crawlError.createMany({
        data: chunk.map((e) => ({ crawlId: id, url: e.url, message: e.message })),
      });
      counts.errorsWritten += chunk.length;
    });

    phase = "save-finalize";
    await prisma.crawl.update({
      where: { id },
      data: {
        status: "done",
        pages: summary.pages,
        ok: summary.ok,
        errors: summary.errors,
        redirects: summary.redirects,
        orphans: summary.orphans,
        noindex: summary.noindex,
        dup: summary.dupTitles,
        dupH1s: summary.dupH1s,
        health: summary.health,
        truncated: result.truncated,
        finishedAt: new Date(),
      },
    });

    console.log(
      `[crawl:${id}] 保存完了 pages=${counts.pagesWritten} edges=${counts.edgesWritten} errors=${counts.errorsWritten}` +
        ` truncated=${result.truncated} reason=${result.stopReason ?? "-"}` +
        ` saveMs=${Date.now() - saveStartedAt} totalMs=${Date.now() - startedAt} ${memoryStat()}`
    );
    crawlEvents.emit(id, {
      type: "done",
      data: { id, truncated: result.truncated, stopReason: result.stopReason },
    } satisfies ProgressEvent);
  } catch (err: any) {
    // 失敗を握りつぶさず必ず記録する。原因調査ができないと同種の障害（対象サイトのブロック・
    // ネットワーク断・SSRF拒否等）が繰り返し発生していても気付けないため。
    // 本番ログはスタックが複数行に分かれて追いにくいため、段階・進捗・理由を1行にまとめた行を先に出す。
    const reason = firstLine(err?.message || err);
    const progress =
      `pages=${counts.pages} pagesWritten=${counts.pagesWritten} edges=${counts.edges} edgesWritten=${counts.edgesWritten}` +
      ` errorsWritten=${counts.errorsWritten}`;
    console.error(
      `[crawl:${id}] FAILED phase=${phase} ${progress} elapsedMs=${Date.now() - startedAt} ${memoryStat()} reason=${reason}`
    );
    console.error(`[crawl:${id}] クロールが失敗しました:`, err?.stack || err?.message || err);
    // チャンク書き込みの途中で失敗した場合に書きかけの行が残らないよう削除する
    try {
      await deleteCrawlRows(id);
    } catch (cleanupErr: any) {
      console.error(`[crawl:${id}] 書きかけデータの削除に失敗しました:`, cleanupErr?.stack || cleanupErr?.message || cleanupErr);
    }
    // 本番ログの保持期間が短いため、失敗理由を CrawlError に1行だけ残す（スキーマ変更なしで DB から追えるように）。
    // CrawlError は現状どの API からも読まれていないため、表示への影響はない。
    try {
      await prisma.crawlError.create({
        data: { crawlId: id, url: opts.startUrl, message: `[FAILED phase=${phase}] ${progress} reason=${reason}`.slice(0, 2000) },
      });
    } catch (recordErr: any) {
      console.error(`[crawl:${id}] 失敗理由の記録に失敗しました:`, recordErr?.stack || recordErr?.message || recordErr);
    }
    try {
      await prisma.crawl.update({ where: { id }, data: { status: "error", finishedAt: new Date() } });
    } catch (updateErr: any) {
      console.error(`[crawl:${id}] 失敗ステータスの保存にも失敗しました:`, updateErr?.stack || updateErr?.message || updateErr);
    }
    crawlEvents.emit(id, { type: "error", data: { message: String(err?.message || err) } } satisfies ProgressEvent);
  } finally {
    running.delete(id);
  }
}

function emitProgress(id: string, p: CrawlProgress) {
  crawlEvents.emit(id, { type: "progress", data: p } satisfies ProgressEvent);
}

export async function recrawl(id: string): Promise<{ id: string } | null> {
  const existing = await prisma.crawl.findUnique({ where: { id } });
  if (!existing) return null;
  return startCrawl({ startUrl: existing.startUrl, maxDepth: existing.maxDepth, label: existing.label });
}
