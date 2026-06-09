import { createFetcher, type Fetcher } from "./fetcher.js";
import { parseHtml, type LinkType } from "./parse.js";
import { toPath, isExternal, slugifyId, resolveHref } from "./url.js";
import { isAllowedByRobots, type RobotsCache } from "./robots.js";
import { SsrfBlockedError, type HostPinCache } from "./ssrf.js";
import { SLOW_TTFB_MS } from "../constants.js";

export interface CrawlOptions {
  startUrl: string;
  maxDepth: number; // 0 = unlimited
  render: boolean;
  concurrency?: number;
  respectRobots?: boolean;
}

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
  edges: CrawledEdge[];
  errors: { url: string; message: string }[];
  truncated: boolean; // MAX_PAGES に達してクロールを打ち切った場合 true
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
  outRaw: { targetPath: string; type: LinkType }[];
}

const RATE_LIMIT_MS = 100; // ~10 req/s per host
const MAX_RETRIES = 2;

// クロール予算の上限（ページ数）。
// ファセットナビ・無限カレンダー・セッションID付きクエリ等、URL空間が事実上無限なサイトを
// 指定された場合でもリソース（CPU/メモリ/DB/Chromiumプロセス）が無制限に消費されないようにする。
export const MAX_PAGES = 10_000;

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
  const fetcher: Fetcher = createFetcher(opts.render, hostPinCache);

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

  const startPath = toPath(origin + "/", host) || "/";
  discovered.add(startPath);
  queue.push({ path: startPath, depth: 0, parentPath: null });

  let active = 0;
  let processed = 0;
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
        return await fetcher.fetch(absoluteUrl);
      } catch (err) {
        // SSRFブロック（DNSリバインディング検知含む）はネットワークの一時的な不調ではなく
        // セキュリティ上の判断のため、リトライせず即座に伝播してクロール全体を中断する
        if (err instanceof SsrfBlockedError) throw err;
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

      // ヒープ使用量が閾値を超えていたらキューを空にして安全に打ち切る
      if (process.memoryUsage().heapUsed > HEAP_LIMIT_BYTES) {
        truncated = true;
        queue.length = 0;
        console.warn(`[crawl] ヒープ使用量が 350MB を超えたため、クロールを安全に打ち切ります (${rawPages.size} ページ取得済)`);
        return;
      }

      active++;
      try {
        const sinceLast = Date.now() - lastFetchAt;
        if (sinceLast < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - sinceLast);
        lastFetchAt = Date.now();

        const allowed = await isAllowedByRobots(origin, item.path, respectRobots, robotsCache, hostPinCache);
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
        const outRaw: { targetPath: string; type: LinkType }[] = [];
        for (const link of parsed.links) {
          if (isExternal(link.absoluteUrl, host)) continue;
          const targetPath = toPath(link.absoluteUrl, host);
          if (!targetPath) continue;
          outRaw.push({ targetPath, type: link.type });
          enqueueIfNew(targetPath, item.depth + 1, item.path);
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
      } finally {
        active--;
        processed++;
      }
    }
  }

  try {
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
  } finally {
    await fetcher.close();
  }

  // ---- assign stable ids ----
  const idOf = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const path of rawPages.keys()) idOf.set(path, slugifyId(path, usedIds));

  // ---- build pages (without inLinks/outLinks yet) ----
  const pages: CrawledPage[] = [];
  for (const raw of rawPages.values()) {
    pages.push({
      id: idOf.get(raw.path)!,
      url: raw.path,
      status: raw.status,
      title: raw.title,
      h1: raw.h1,
      description: raw.description,
      depth: raw.depth,
      parent: raw.parentPath ? idOf.get(raw.parentPath) ?? null : null,
      inLinks: 0,
      outLinks: 0,
      words: raw.words,
      size: raw.size,
      noindex: raw.noindex,
      canonical: raw.canonical,
      redirectTo: raw.redirectTo,
      ttfbMs: raw.ttfbMs,
    });
  }

  // ---- build edges ----
  const edges: CrawledEdge[] = [];
  for (const raw of rawPages.values()) {
    const sId = idOf.get(raw.path)!;
    for (const link of raw.outRaw) {
      const tId = idOf.get(link.targetPath);
      if (!tId || tId === sId) continue;
      edges.push({ s: sId, t: tId, type: link.type });
    }
    if (raw.redirectTo) {
      const tId = idOf.get(raw.redirectTo);
      if (tId && tId !== sId) edges.push({ s: sId, t: tId, type: "redirect" });
    }
  }
  // tree edges（親子構造）— サイトマップのツリー描画用に明示的に追加
  for (const p of pages) {
    if (p.parent) edges.push({ s: p.parent, t: p.id, type: "tree" });
  }

  // ---- in/out links: 被リンク = 自身を指すページ数（重複排除） ----
  const inSets = new Map<string, Set<string>>();
  const outSets = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type === "redirect") continue; // リダイレクトは被リンク集計から除外
    if (!outSets.has(e.s)) outSets.set(e.s, new Set());
    outSets.get(e.s)!.add(e.t);
    if (!inSets.has(e.t)) inSets.set(e.t, new Set());
    inSets.get(e.t)!.add(e.s);
  }
  for (const p of pages) {
    p.inLinks = inSets.get(p.id)?.size ?? 0;
    p.outLinks = outSets.get(p.id)?.size ?? 0;
  }

  return { host, pages, edges, errors, truncated };
}

export { SLOW_TTFB_MS };
