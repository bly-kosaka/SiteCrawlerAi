import type { Page as DbPage, Crawl as DbCrawl } from "@prisma/client";

// DB行 → フロントが期待する Page 型へ変換（issues は JSON文字列 → 配列）
export interface PageDTO {
  id: string;
  url: string;
  status: number;
  title: string;
  h1: string;
  depth: number;
  parent: string | null;
  inLinks: number;
  outLinks: number;
  words: number;
  size: number;
  noindex: boolean;
  canonical: string;
  redirectTo?: string;
  issues: string[];
}

export function toPageDTO(p: DbPage): PageDTO {
  return {
    id: p.id,
    url: p.url,
    status: p.status,
    title: p.title,
    h1: p.h1,
    depth: p.depth,
    parent: p.parent,
    inLinks: p.inLinks,
    outLinks: p.outLinks,
    words: p.words,
    size: p.size,
    noindex: p.noindex,
    canonical: p.canonical,
    redirectTo: p.redirectTo ?? undefined,
    issues: JSON.parse(p.issues || "[]"),
  };
}

export interface CrawlDTO {
  id: string;
  host: string;
  label: string;
  status: string;
  pages: number;
  errors: number;
  redirects: number;
  orphans: number;
  dup: number;
  health: number;
  truncated: boolean;
  ts: string;
  when: string;
  active: boolean;
  startUrl: string;
  maxDepth: number;
}

function formatTs(d: Date | null): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeWhen(d: Date | null): string {
  if (!d) return "";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨日";
  if (day < 7) return `${day}日前`;
  return "先週";
}

export function toCrawlDTO(c: DbCrawl): CrawlDTO {
  const ts = c.finishedAt ?? c.createdAt;
  return {
    id: c.id,
    host: c.host,
    label: c.label,
    status: c.status,
    pages: c.pages,
    errors: c.errors,
    redirects: c.redirects,
    orphans: c.orphans,
    dup: c.dup,
    health: c.health,
    truncated: c.truncated,
    ts: formatTs(ts),
    when: relativeWhen(ts),
    active: c.active,
    startUrl: c.startUrl,
    maxDepth: c.maxDepth,
  };
}

// flat + parent から木構造を構築（フロントの TREE 互換）
export interface PageTreeNode extends PageDTO {
  children?: PageTreeNode[];
}

export function buildTree(pages: PageDTO[]): PageTreeNode | null {
  const byId = new Map<string, PageTreeNode>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  let root: PageTreeNode | null = null;
  for (const p of pages) {
    const node = byId.get(p.id)!;
    if (p.parent && byId.has(p.parent)) {
      byId.get(p.parent)!.children!.push(node);
    } else if (p.depth === 0) {
      root = node;
    }
  }
  if (!root) root = byId.values().next().value ?? null;
  return root;
}
