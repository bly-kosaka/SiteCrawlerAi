import { createFetcher, ResponseTooLargeError, type Fetcher } from "./fetcher.js";
import { parseHtml, type LinkType } from "./parse.js";
import { toPath, isExternal, slugifyId, resolveHref } from "./url.js";
import { isAllowedByRobots, type RobotsCache } from "./robots.js";
import { SsrfBlockedError, type HostPinCache } from "./ssrf.js";
import { SLOW_TTFB_MS } from "../constants.js";

export interface CrawlOptions {
  startUrl: string;
  maxDepth: number; // 0 = unlimited
  concurrency?: number;
  respectRobots?: boolean;
  // 外部からの中止（キャンセル API）用シグナル。中止されるとそれまでの結果で打ち切る
  signal?: AbortSignal;
  // クロール（取得フェーズ）全体の時間上限。省略時は MAX_CRAWL_DURATION_MS
  timeLimitMs?: number;
}

// 打ち切り理由
//   pages : MAX_PAGES に達したため新しい URL をキューに積むのをやめた（積み済みのページは取得する）
//   heap  : ヒープ使用量が上限を超えたため残りのキューを捨てた
//   time  : 時間上限に達したため残りのキューを捨て、進行中の取得も中断した
//   cancel: キャンセル API により残りのキューを捨て、進行中の取得も中断した
export type StopReason = "pages" | "heap" | "time" | "cancel";

export interface CrawledPage {
  id: string;
  url: string; // host-relative path
  status: number;
  title: string;
  h1: string;
  description: string;
  depth: number;
  parent: string | null; // page id
  inLinks: number;
  outLinks: number;
  words: number;
  size: number;
  noindex: boolean;
  canonical: string; // 'self' | absolute or relative URL
  redirectTo?: string; // path
  ttfbMs: number;
}

export interface CrawledEdge {
  s: string; // page id
  t: string; // page id
  type: "tree" | "nav" | "footer" | "context" | "redirect";
}

export interface CrawlProgress {
  pct: number;
  found: number;
  total: number;
  queue: number;
  speed: number;
  cur: string;
}

export interface CrawlResult {
  host: string;
  pages: CrawledPage[];
  errors: { url: string; message: string }[];
  truncated: boolean; // MAX_PAGES 到達・ヒープ上限・時間上限・キャンセルのいずれかでクロールを打ち切った場合 true
  // 打ち切り理由（truncated が false なら null）。複数該当した場合は取得を止めた直接の理由
  // （heap/time/cancel）を pages より優先する
  stopReason: StopReason | null;
  // 重複排除済み edges の総数（edgeBatches が返す件数の合計）
  edgeCount: number;
  // 重複排除済み edges を最大 size 件ずつのバッチで順に返す。
  // 全 edges を1つの配列として実体化すると「ページ数×リンク数」規模の配列とその DB 書き込み用コピーが
  // 同時にメモリに載るため、DB 書き込み側がバッチ単位で受け取り、書き終えたら参照を捨てられる形にしている。
  // 走査済みページの発リンク情報は走査中に解放するため、走査できるのは1回だけ。
  edgeBatches(size: number): Generator<CrawledEdge[]>;
}

interface QueueItem {
  path: string;
  depth: number;
  parentPath: string | null;
}

interface RawPageData {
  path: string;
  depth: number;
  parentPath: string | null;
  status: number;
  title: string;
  h1: string;
  description: string;
  noindex: boolean;
  canonical: string;
  redirectTo?: string;
  words: number;
  size: number;
  ttfbMs: number;
  // 同一ページ内で (targetPath, type) が重複しない発リンク一覧（自己リンクは含めない）
  outRaw: { targetPath: string; type: LinkType }[];
}

const RATE_LIMIT_MS = 100; // ~10 req/s per host
const MAX_RETRIES = 2;

// クロール予算の上限（ページ数）。
// ファセットナビ・無限カレンダー・セッションID付きクエリ等、URL空間が事実上無限なサイトを
// 指定された場合でもリソース（CPU/メモリ/DB）が無制限に消費されないようにする。
export const MAX_PAGES = 10_000;

// クロール（取得フェーズ）全体の時間上限。超えたら新規取得をやめ、それまでの結果を truncated として保存する。
// 本番実績（最大 3,784 ページ）に対して十分な余裕を持たせつつ、応答の遅いサイトや URL 空間が
// 事実上無限なサイトでプロセスのリソースを長時間占有し続けないようにするための値。
// （DB への保存はこの時間に含めない。保存を途中で止めると結果が残らないため）
export const MAX_CRAWL_DURATION_MS = 60 * 60 * 1000; // 60 分

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runCrawl(
  opts: CrawlOptions,
  onProgress?: (p: CrawlProgress) => void
): Promise<CrawlResult> {
  // クロール起点URLはユーザーが指定したスキーム（http/https）をそのまま使う。
  // 固定で https:// を補ってしまうと、HTTPのみ対応のサイト（社内検証環境等）を
  // 全ページ接続エラーで終わらせてしまうため。
  const startUrlParsed = new URL(opts.startUrl);
  const host = startUrlParsed.hostname;
  const origin = startUrlParsed.origin;
  const concurrency = opts.concurrency ?? 5;
  const respectRobots = opts.respectRobots ?? true;
  const maxDepth = opts.maxDepth;

  // クロール内で観測したホストの解決先IPを記録し、途中で値が変化したら
  // DNSリバインディングの兆候とみなして即座に中断する（軽量な変化検知。詳しくは ssrf.ts 参照）
  const hostPinCache: HostPinCache = new Map();
  const fetcher: Fetcher = createFetcher(hostPinCache);

  // robots.txt の解析結果キャッシュはこのクロール内に閉じる(プロセス全体で共有しない)。
  // 共有してしまうと、過去のクロールでSSRF検証を通過したoriginの結果が
  // 別のクロール(=DNSが書き換わっている可能性がある)でも再利用され、
  // assertPublicHostによる再検証を素通りする経路になり得るため(robots.ts参照)。
  const robotsCache: RobotsCache = new Map();

  const discovered = new Set<string>();
  const queue: QueueItem[] = [];
  const rawPages = new Map<string, RawPageData>();
  const errors: { url: string; message: string }[] = [];
  let truncated = false;
  let stopReason: StopReason | null = null;

  // ---- 中断（時間上限・キャンセル） ----
  // 進行中の HTTP 取得（robots.txt 含む）にはこのシグナルを渡し、中断時に速やかに止める
  const halt = new AbortController();
  // 残りのキューを捨てて打ち切る。abortInFlight が true なら進行中の取得も中断する
  function stopCrawl(reason: StopReason, abortInFlight: boolean) {
    truncated = true;
    if (!stopReason || stopReason === "pages") stopReason = reason;
    queue.length = 0;
    if (abortInFlight && !halt.signal.aborted) halt.abort(new Error(`クロールを中断しました (reason=${reason})`));
  }
  const onExternalAbort = () => stopCrawl("cancel", true);
  const timeLimitMs = opts.timeLimitMs ?? MAX_CRAWL_DURATION_MS;
  const timeLimitTimer = setTimeout(() => {
    console.warn(`[crawl] 時間上限 (${Math.round(timeLimitMs / 60000)}分) に達したため、クロールを打ち切ります (${rawPages.size} ページ取得済)`);
    stopCrawl("time", true);
  }, timeLimitMs);

  const startPath = toPath(origin + "/", host) || "/";
  discovered.add(startPath);
  queue.push({ path: startPath, depth: 0, parentPath: null });

  let active = 0;
  let processed = 0;
  // ページ単位で記録して続行した例外の件数（ログが大量に出ないよう先頭の数件だけ出力するため）
  let pageFailures = 0;
  let lastFetchAt = 0;
  let lastTickProcessed = 0;
  let lastTickAt = Date.now();
  let estimatedTotal = Math.max(20, queue.length);

  const reportProgress = (cur: string) => {
    if (!onProgress) return;
    const now = Date.now();
    const elapsedSec = (now - lastTickAt) / 1000;
    const speed = elapsedSec > 0 ? Math.round(((processed - lastTickProcessed) / elapsedSec) * 10) / 10 : 0;
    if (elapsedSec >= 1) {
      lastTickProcessed = processed;
      lastTickAt = now;
    }
    estimatedTotal = Math.max(estimatedTotal, processed + queue.length + active);
    const pct = estimatedTotal > 0 ? Math.min(99, Math.round((processed / estimatedTotal) * 100)) : 0;
    onProgress({
      pct,
      found: processed,
      total: estimatedTotal,
      queue: queue.length,
      speed,
      cur,
    });
  };

  async function fetchWithRetry(absoluteUrl: string) {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fetcher.fetch(absoluteUrl, { signal: halt.signal });
      } catch (err) {
        // SSRFブロック（DNSリバインディング検知含む）はネットワークの一時的な不調ではなく
        // セキュリティ上の判断のため、リトライせず即座に伝播してクロール全体を中断する
        if (err instanceof SsrfBlockedError) throw err;
        // 中断（時間上限・キャンセル）や本文サイズ超過は再試行しても結果が変わらないためリトライしない
        if (halt.signal.aborted || err instanceof ResponseTooLargeError) throw err;
        lastErr = err;
        if (attempt < MAX_RETRIES) await sleep(300 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  function enqueueIfNew(path: string, depth: number, parentPath: string | null): boolean {
    if (discovered.has(path)) return false;
    if (maxDepth !== 0 && depth > maxDepth) return false;
    if (discovered.size >= MAX_PAGES) {
      truncated = true;
      if (!stopReason) stopReason = "pages";
      return false;
    }
    discovered.add(path);
    queue.push({ path, depth, parentPath });
    return true;
  }

  // ヒープ使用量の安全上限。クロール対象が大規模サイト(大学/ECサイト等)の場合、
  // rawPages に大量のデータが蓄積されて Railway コンテナの RAM 上限を超えてしまい、
  // プロセスが OS に強制終了(OOM Kill)されることがあった。
  // --max-old-space-size=512(Dockerfile) と組み合わせて、この閾値を超えたらクロールを
  // 安全に truncated 停止させ、DB に保存・完了状態にできるようにする。
  const HEAP_LIMIT_BYTES = 350 * 1024 * 1024; // 350 MB

  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await sleep(50);
        continue;
      }

      // 時間上限・キャンセルで中断済みなら新規取得はしない（キューは stopCrawl で空にしているが念のため）
      if (halt.signal.aborted) {
        queue.length = 0;
        return;
      }

      // ヒープ使用量が閾値を超えていたらキューを空にして安全に打ち切る
      if (process.memoryUsage().heapUsed > HEAP_LIMIT_BYTES) {
        stopCrawl("heap", false);
        console.warn(`[crawl] ヒープ使用量が 350MB を超えたため、クロールを安全に打ち切ります (${rawPages.size} ページ取得済)`);
        return;
      }

      active++;
      try {
        const sinceLast = Date.now() - lastFetchAt;
        if (sinceLast < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - sinceLast);
        lastFetchAt = Date.now();

        const allowed = await isAllowedByRobots(origin, item.path, respectRobots, robotsCache, hostPinCache, halt.signal);
        // robots.txt の取得中に中断された場合、このページは取得していないので結果に含めない
        if (halt.signal.aborted) continue;
        if (!allowed) {
          rawPages.set(item.path, {
            path: item.path,
            depth: item.depth,
            parentPath: item.parentPath,
            status: 0,
            title: "",
            h1: "",
            description: "",
            noindex: true,
            canonical: "self",
            words: 0,
            size: 0,
            ttfbMs: 0,
            outRaw: [],
          });
          continue;
        }

        const absoluteUrl = origin + item.path;
        reportProgress(item.path);

        let res;
        try {
          res = await fetchWithRetry(absoluteUrl);
        } catch (err: any) {
          // SSRFブロック（DNSリバインディング検知含む）はこのページだけの問題ではなく
          // クロール対象ホストの安全性そのものに関わるため、握りつぶさずクロール全体を中断する
          if (err instanceof SsrfBlockedError) throw err;
          // 中断（時間上限・キャンセル）による失敗はページ側の問題ではないため取得エラーとして記録しない。
          // 取得途中だったページは、キューに残っていたページと同様に結果に含めない
          if (halt.signal.aborted) continue;
          errors.push({ url: item.path, message: String(err?.message || err) });
          continue;
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers["location"];
          let redirectToPath: string | undefined;
          if (location) {
            const abs = resolveHref(location, absoluteUrl);
            if (abs && !isExternal(abs, host)) {
              redirectToPath = toPath(abs, host) || undefined;
            }
          }
          rawPages.set(item.path, {
            path: item.path,
            depth: item.depth,
            parentPath: item.parentPath,
            status: res.status,
            title: "",
            h1: "",
            description: "",
            noindex: false,
            canonical: "self",
            redirectTo: redirectToPath,
            words: 0,
            size: 0,
            ttfbMs: res.ttfbMs,
            outRaw: [],
          });
          if (redirectToPath) {
            enqueueIfNew(redirectToPath, item.depth + 1, item.path);
          }
          continue;
        }

        if (!res.html) {
          rawPages.set(item.path, {
            path: item.path,
            depth: item.depth,
            parentPath: item.parentPath,
            status: res.status,
            title: "",
            h1: "",
            description: "",
            noindex: false,
            canonical: "self",
            words: 0,
            size: 0,
            ttfbMs: res.ttfbMs,
            outRaw: [],
          });
          continue;
        }

        const parsed = parseHtml(res.html, absoluteUrl, res.headers["x-robots-tag"]);
        // ヘッダー/フッター等で同じリンクがページ内に何度も現れても、(リンク先, 種別) ごとに1本だけ保持する。
        // 重複のまま保持すると全ページ分で「ページ数×リンク数」規模に膨らみ、終了時の edges 書き込みで
        // Prisma エンジンが V8 ヒープ外に数GBを確保する原因になっていた。
        // 被リンク/発リンク数はもともとリンク元/先ページの Set で数えているため、集計結果は変わらない。
        const outRaw: { targetPath: string; type: LinkType }[] = [];
        const seenOut = new Set<string>();
        for (const link of parsed.links) {
          if (isExternal(link.absoluteUrl, host)) continue;
          const targetPath = toPath(link.absoluteUrl, host);
          if (!targetPath) continue;
          enqueueIfNew(targetPath, item.depth + 1, item.path);
          // 自己リンクは最終的に edges から除外される（path と id は1対1）ため保持しない
          if (targetPath === item.path) continue;
          const key = link.type + "\u0000" + targetPath;
          if (seenOut.has(key)) continue;
          seenOut.add(key);
          outRaw.push({ targetPath, type: link.type });
        }

        let canonical = "self";
        if (parsed.canonical) {
          const cPath = isExternal(parsed.canonical, host) ? parsed.canonical : toPath(parsed.canonical, host);
          if (cPath && cPath !== item.path) canonical = cPath;
        }

        rawPages.set(item.path, {
          path: item.path,
          depth: item.depth,
          parentPath: item.parentPath,
          status: res.status,
          title: parsed.title,
          h1: parsed.h1,
          description: parsed.description,
          noindex: parsed.noindex,
          canonical,
          words: parsed.words,
          size: parsed.sizeKb,
          ttfbMs: res.ttfbMs,
          outRaw,
        });
      } catch (err: any) {
        // SSRFブロック（DNSリバインディング検知含む）は対象ホスト自体の安全性に関わるため、
        // 従来どおりクロール全体を中断する（runCrawl の呼び出し元へ伝播させる）
        if (err instanceof SsrfBlockedError) throw err;
        // 中断（時間上限・キャンセル・他ワーカーの失敗）による例外は記録しない
        if (halt.signal.aborted) continue;
        // それ以外（HTML 解析時の例外等）はこのページだけの問題なので、取得エラーと同様に
        // CrawlError に記録して続行する。以前はワーカーの例外がそのままクロール全体の失敗になり、
        // 1ページの解析失敗で取得済みの全結果が失われていた。
        const message = String(err?.message || err);
        pageFailures++;
        if (pageFailures <= 5) console.warn(`[crawl] ページの処理中に例外が発生しました（このページのみ記録して続行）: ${item.path} — ${message}`);
        errors.push({ url: item.path, message: `ページの処理中にエラーが発生しました: ${message}` });
      } finally {
        active--;
        processed++;
      }
    }
  }

  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) stopCrawl("cancel", true);
  // ワーカーのいずれかが例外を投げた場合（SSRF ブロック等）は、残りのワーカーも速やかに止めてから
  // 最初の例外を投げ直す。以前は Promise.all が即座に reject して呼び出し元が実行枠を解放する一方、
  // 残りのワーカーはキューを処理し続けていたため、解放後も取得が続き、同時1本の制限・時間上限・
  // キャンセルがすべて効かなくなっていた。
  let failure: { error: unknown } | null = null;
  const failCrawl = (error: unknown) => {
    if (!failure) failure = { error };
    queue.length = 0;
    if (!halt.signal.aborted) halt.abort(error);
  };
  try {
    const workers = Array.from({ length: concurrency }, () => worker().catch(failCrawl));
    // 各ワーカーの例外は failCrawl で受け止めているため、これは全ワーカーの終了を待つだけ（reject しない）
    await Promise.all(workers);
  } finally {
    clearTimeout(timeLimitTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await fetcher.close();
  }
  if (failure) throw (failure as { error: unknown }).error;

  // ---- assign stable ids ----
  const idOf = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const path of rawPages.keys()) idOf.set(path, slugifyId(path, usedIds));

  // ---- build pages (without inLinks/outLinks yet) ----
  const pages: CrawledPage[] = [];
  // tree edges 用: 親ページ id → 子ページ id 一覧（被リンク/発リンク集計で使う）
  const childrenOf = new Map<string, string[]>();
  // tree edges 書き出し用: ページ順に [親 id, 子 id, 親 id, 子 id, ...] と平坦に保持する
  const treePairs: string[] = [];
  for (const raw of rawPages.values()) {
    const id = idOf.get(raw.path)!;
    const parent = raw.parentPath ? idOf.get(raw.parentPath) ?? null : null;
    pages.push({
      id,
      url: raw.path,
      status: raw.status,
      title: raw.title,
      h1: raw.h1,
      description: raw.description,
      depth: raw.depth,
      parent,
      inLinks: 0,
      outLinks: 0,
      words: raw.words,
      size: raw.size,
      noindex: raw.noindex,
      canonical: raw.canonical,
      redirectTo: raw.redirectTo,
      ttfbMs: raw.ttfbMs,
    });
    if (parent) {
      treePairs.push(parent, id);
      const list = childrenOf.get(parent);
      if (list) list.push(id);
      else childrenOf.set(parent, [id]);
    }
  }

  // ---- in/out links: 被リンク = 自身を指すページ数（重複排除） ----
  // 以前は全 edges 配列を作ってから Map<id, Set<id>> で集計していたが、終了時のメモリピークを
  // 抑えるため edges 配列は作らず、リンク元ページ単位で「リンク先 id の Set」を作って数える。
  // 各リンク元ページは1回しか処理しないので、(リンク元, リンク先) の組は高々1回しか数えられず、
  // 対象 edges（tree/nav/footer/context。redirect は集計から除外）も従来と同じなので結果は一致する。
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  let edgeCount = 0;
  for (const raw of rawPages.values()) {
    const sId = idOf.get(raw.path)!;
    const targets = new Set<string>();
    for (const link of raw.outRaw) {
      const tId = idOf.get(link.targetPath);
      if (!tId || tId === sId) continue;
      targets.add(tId);
      edgeCount++;
    }
    const children = childrenOf.get(sId);
    if (children) {
      for (const c of children) targets.add(c);
      edgeCount += children.length;
    }
    if (raw.redirectTo) {
      const tId = idOf.get(raw.redirectTo);
      if (tId && tId !== sId) edgeCount++;
    }
    if (targets.size) outCount.set(sId, targets.size);
    for (const t of targets) inCount.set(t, (inCount.get(t) ?? 0) + 1);
  }
  childrenOf.clear();
  for (const p of pages) {
    p.inLinks = inCount.get(p.id) ?? 0;
    p.outLinks = outCount.get(p.id) ?? 0;
  }
  inCount.clear();
  outCount.clear();

  // ---- edges（バッチ単位で遅延生成） ----
  // 順序は従来と同じ（ページ順に各ページの発リンク→リダイレクト、最後に tree edges をページ順）。
  // (s, t, type) の重複は、ページ内で (targetPath, type) を重複排除済み・リダイレクトはページ毎に高々1本・
  // tree は子ページ毎に1本（親は1つ）であることから、全体でも発生しない。
  let consumed = false;
  function* edgeBatches(size: number): Generator<CrawledEdge[]> {
    if (consumed) throw new Error("edgeBatches は1回しか走査できません");
    consumed = true;
    const batchSize = Math.max(1, Math.floor(size));
    let batch: CrawledEdge[] = [];
    for (const raw of rawPages.values()) {
      const sId = idOf.get(raw.path)!;
      for (const link of raw.outRaw) {
        const tId = idOf.get(link.targetPath);
        if (!tId || tId === sId) continue;
        batch.push({ s: sId, t: tId, type: link.type });
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }
      // edge に変換し終えた発リンク一覧は参照を切って GC 対象にする
      raw.outRaw = [];
      if (raw.redirectTo) {
        const tId = idOf.get(raw.redirectTo);
        if (tId && tId !== sId) {
          batch.push({ s: sId, t: tId, type: "redirect" });
          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
          }
        }
      }
    }
    rawPages.clear();
    idOf.clear();
    // tree edges（親子構造）— サイトマップのツリー描画用に明示的に追加
    // （呼び出し側が pages 配列を加工・解放しても影響を受けないよう、親子の組は別に保持している）
    for (let i = 0; i < treePairs.length; i += 2) {
      batch.push({ s: treePairs[i], t: treePairs[i + 1], type: "tree" });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    treePairs.length = 0;
    if (batch.length) yield batch;
  }

  return { host, pages, errors, truncated, stopReason, edgeCount, edgeBatches };
}

export { SLOW_TTFB_MS };
