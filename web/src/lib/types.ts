/* Frontend data types — mirror server DTOs (server/src/serialize.ts, constants.ts) */

export type Issue = "broken" | "redirect" | "orphan" | "dup-title" | "dup-h1" | "noindex" | "slow";

export interface PageNode {
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
  status: "running" | "done" | "error";
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
  edges: Edge[];
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

export interface CrawlProgress {
  pct: number;
  found: number;
  total: number;
  queue: number;
  speed: number;
  cur: string;
}
