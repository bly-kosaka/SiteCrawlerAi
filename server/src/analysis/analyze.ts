import type { CrawledPage, CrawledEdge } from "../crawler/engine.js";
import { SLOW_TTFB_MS, type Issue } from "../constants.js";

export interface AnalyzedPage extends CrawledPage {
  issues: Issue[];
}

// computeSummary / buildRedirectChains / orphanReason が要求する最小形状。
// AnalyzedPage(issues: Issue[]) と PageDTO(issues: string[]) の両方を
// キャスト無しで受け付けられるよう構造的に定義する。
export interface AnalyzablePage {
  url: string;
  status: number;
  redirectTo?: string;
  noindex: boolean;
  issues: string[];
}

export interface AnalysisSummary {
  pages: number;
  ok: number;
  errors: number;
  redirects: number;
  orphans: number;
  noindex: number;
  dupTitles: number;
  dupH1s: number;
  health: number;
}

const BROKEN_CODES = new Set([404, 410, 500]);
const REDIRECT_CODES = new Set([301, 302]);

/**
 * issue 判定:
 *  - broken: status が 4xx/5xx
 *  - redirect: status が 3xx
 *  - orphan: inLinks === 0（ルート [depth===0] を除く — クロール起点は構造上孤立扱いしない）
 *  - dup-title / dup-h1: 同一クロール内で title / h1 が他に1件以上存在（空文字は対象外）
 *  - noindex: meta robots / X-Robots-Tag に noindex
 *  - slow: TTFB > 600ms
 */
export function analyzePages(pages: CrawledPage[], _edges: CrawledEdge[]): AnalyzedPage[] {
  const titleCount = new Map<string, number>();
  const h1Count = new Map<string, number>();
  for (const p of pages) {
    if (p.title) titleCount.set(p.title, (titleCount.get(p.title) ?? 0) + 1);
    if (p.h1) h1Count.set(p.h1, (h1Count.get(p.h1) ?? 0) + 1);
  }

  return pages.map((p) => {
    const issues: Issue[] = [];
    if (BROKEN_CODES.has(p.status)) issues.push("broken");
    if (REDIRECT_CODES.has(p.status)) issues.push("redirect");
    if (p.depth > 0 && p.inLinks === 0) issues.push("orphan");
    if (p.title && (titleCount.get(p.title) ?? 0) > 1) issues.push("dup-title");
    if (p.h1 && (h1Count.get(p.h1) ?? 0) > 1) issues.push("dup-h1");
    if (p.noindex) issues.push("noindex");
    if (p.ttfbMs > SLOW_TTFB_MS) issues.push("slow");
    return { ...p, issues };
  });
}

export function computeSummary(pages: AnalyzablePage[]): AnalysisSummary {
  const errors = pages.filter((p) => BROKEN_CODES.has(p.status)).length;
  const redirects = pages.filter((p) => REDIRECT_CODES.has(p.status)).length;
  const orphans = pages.filter((p) => p.issues.includes("orphan")).length;
  const dupTitles = pages.filter((p) => p.issues.includes("dup-title")).length;
  const dupH1s = pages.filter((p) => p.issues.includes("dup-h1")).length;
  const noindex = pages.filter((p) => p.noindex).length;
  const ok = pages.filter((p) => p.status === 200).length;

  return {
    pages: pages.length,
    ok,
    errors,
    redirects,
    orphans,
    noindex,
    dupTitles,
    dupH1s,
    health: computeHealth({ pages: pages.length, errors, orphans, redirects, dupTitles, noindex, multiHopRedirects: countMultiHop(pages) }),
  };
}

function countMultiHop(pages: AnalyzablePage[]): number {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  let count = 0;
  for (const p of pages) {
    if (!REDIRECT_CODES.has(p.status)) continue;
    let hops = 1;
    let cur: AnalyzablePage | undefined = p;
    let guard = 0;
    while (cur?.redirectTo && guard < 8) {
      const next = byUrl.get(cur.redirectTo);
      hops++;
      if (!next || !REDIRECT_CODES.has(next.status)) break;
      cur = next;
      guard++;
    }
    if (hops > 2) count++;
  }
  return count;
}

/**
 * health = 100
 *   - errors    × -4
 *   - orphans   × -2
 *   - redirects × -1（2段以上のチェーンは追加 -1）
 *   - dup-title × -1
 *   - noindex   × -0.5
 * 下限0、四捨五入
 */
function computeHealth(s: {
  pages: number;
  errors: number;
  orphans: number;
  redirects: number;
  dupTitles: number;
  noindex: number;
  multiHopRedirects: number;
}): number {
  let score = 100;
  score -= s.errors * 4;
  score -= s.orphans * 2;
  score -= s.redirects * 1;
  score -= s.multiHopRedirects * 1;
  score -= s.dupTitles * 1;
  score -= s.noindex * 0.5;
  return Math.max(0, Math.round(score));
}

export interface RedirectChain {
  from: string;
  hops: { url: string; status: number }[];
  depth: number;
}

export function buildRedirectChains(pages: AnalyzablePage[]): RedirectChain[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const all = pages.filter((p) => REDIRECT_CODES.has(p.status));
  return all.map((p) => {
    const hops: { url: string; status: number }[] = [{ url: p.url, status: p.status }];
    let cur: AnalyzablePage | undefined = p;
    let guard = 0;
    while (cur?.redirectTo && guard < 8) {
      const next = byUrl.get(cur.redirectTo);
      hops.push({ url: cur.redirectTo, status: next ? next.status : 404 });
      if (!next || !REDIRECT_CODES.has(next.status)) break;
      cur = next;
      guard++;
    }
    return { from: p.url, hops, depth: hops.length - 1 };
  });
}

export function orphanReason(p: AnalyzablePage): string {
  const reasons = ["内部リンクなし"];
  if (p.noindex) reasons.push("noindex");
  if (p.status === 404 || p.status === 410) reasons.push("削除済");
  return reasons.join(" ・ ");
}
