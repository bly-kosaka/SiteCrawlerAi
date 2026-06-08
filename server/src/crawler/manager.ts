import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { runCrawl, type CrawlProgress } from "./engine.js";
import { analyzePages, computeSummary } from "../analysis/analyze.js";
import { normalizeHost } from "./url.js";
import { assertSafeStartUrl, SsrfBlockedError } from "./ssrf.js";

export class StartCrawlValidationError extends Error {}

type ProgressEvent = { type: "progress"; data: CrawlProgress } | { type: "done"; data: { id: string } } | { type: "error"; data: { message: string } };

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

const running = new Set<string>();

export function newCrawlId(): string {
  return "cr_" + randomBytes(3).toString("hex");
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

export interface StartCrawlInput {
  startUrl: string;
  maxDepth: number;
  label?: string;
  render?: boolean;
}

export async function startCrawl(input: StartCrawlInput): Promise<{ id: string }> {
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
  const id = newCrawlId();

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
  // 新しいクロールをアクティブにし、他は非アクティブへ
  await prisma.crawl.updateMany({ where: { id: { not: id } }, data: { active: false } });

  void executeCrawl(id, { startUrl, maxDepth: input.maxDepth, render: input.render ?? true });
  return { id };
}

async function executeCrawl(id: string, opts: { startUrl: string; maxDepth: number; render: boolean }) {
  running.add(id);
  try {
    await prisma.crawl.update({ where: { id }, data: { status: "running" } });

    const result = await runCrawl(
      { startUrl: opts.startUrl, maxDepth: opts.maxDepth, render: opts.render },
      (p) => emitProgress(id, p)
    );

    const analyzed = analyzePages(result.pages, result.edges);
    const summary = computeSummary(analyzed);

    await prisma.$transaction(async (tx) => {
      await tx.page.deleteMany({ where: { crawlId: id } });
      await tx.edge.deleteMany({ where: { crawlId: id } });
      await tx.crawlError.deleteMany({ where: { crawlId: id } });

      if (analyzed.length) {
        await tx.page.createMany({
          data: analyzed.map((p) => ({
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
      }
      if (result.edges.length) {
        await tx.edge.createMany({
          data: result.edges.map((e) => ({ crawlId: id, s: e.s, t: e.t, type: e.type })),
        });
      }
      if (result.errors.length) {
        await tx.crawlError.createMany({
          data: result.errors.map((e) => ({ crawlId: id, url: e.url, message: e.message })),
        });
      }

      await tx.crawl.update({
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
    });

    crawlEvents.emit(id, { type: "done", data: { id } } satisfies ProgressEvent);
  } catch (err: any) {
    // 失敗を握りつぶさず必ず記録する。原因調査ができないと同種の障害（対象サイトのブロック・
    // ネットワーク断・SSRF拒否等）が繰り返し発生していても気付けないため。
    console.error(`[crawl:${id}] クロールが失敗しました:`, err?.stack || err?.message || err);
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
  // render を渡さないと startCrawl 側で `?? true`(JSレンダリングあり)が既定値となり、
  // UIから開始する通常クロール(常に render: false)と挙動が食い違う。
  // 本番のPlaywright実行環境ではレンダリングが機能せず、再クロールが
  // 「0ページで完了したように見える」(全ページ取得失敗)不具合の原因になっていたため、
  // 通常クロールと同じ render: false を明示する。
  return startCrawl({ startUrl: existing.startUrl, maxDepth: existing.maxDepth, label: existing.label, render: false });
}
