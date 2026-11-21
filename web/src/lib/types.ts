/* Frontend data types — mirror server DTOs (server/src/serialize.ts, constants.ts) */

export type Issue = "broken" | "redirect" | "orphan" | "dup-title" | "dup-h1" | "noindex" | "slow";

export interface PageNode {
  id: string;
  url: string;
  status: number;
  title: string;
  h1: string;
  description: string;
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

export interface PageDetail extends PageNode {
  linkedFrom: { url: string; title: string; status: number }[];
}

export interface PageTreeNode extends PageNode {
  children?: PageTreeNode[];
}

export interface Edge {
  s: string;
  t: string;
  type: "tree" | "nav" | "footer" | "context" | "redirect";
}

export interface CrawlSummary {
  id: string;
  host: string;
  label: string;
  startUrl: string;
  maxDepth: number;
  status: "queued" | "running" | "done" | "error";
  pages: number;
  errors: number;
  redirects: number;
  orphans: number;
  dup: number;
  health: number;
  truncated: boolean;
  active: boolean;
  ts: string;
  when: string;
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

export interface RedirectChain {
  from: string;
  hops: { url: string; status: number }[];
  depth: number;
}

export interface SiteData {
  crawl: CrawlSummary;
  tree: PageTreeNode | null;
  flat: PageNode[];
  // edges 本体は遅延取得（useSite().ensureEdges）。ここには件数のみ持つ。
  edgeCount: number;
  summary: AnalysisSummary;
  host: string;
  counts: {
    pages: number;
    ok: number;
    errors: number;
    redirects: number;
    orphans: number;
    noindex: number;
    dupTitles: number;
  };
}

// クロールが途中で打ち切られた理由（進捗 SSE の done イベントでのみ通知され、DB には残らない）
//   pages: ページ数上限 / heap: メモリ保護 / time: 時間上限 / cancel: ユーザーによる中止
export type StopReason = "pages" | "heap" | "time" | "cancel";

export interface CrawlDoneEvent {
  id: string;
  truncated: boolean;
  stopReason: StopReason | null;
}

export interface CrawlProgress {
  pct: number;
  found: number;
  total: number;
  queue: number;
  speed: number;
  cur: string;
}
