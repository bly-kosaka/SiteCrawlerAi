import type { PageDTO, PageTreeNode, CrawlDTO } from "../serialize.js";
import type { CrawledEdge } from "../crawler/engine.js";
import { ISSUE_LABEL_JP, EDGE_TYPE_JP, STATUS_JP, type Issue } from "../constants.js";
import { buildRedirectChains, orphanReason } from "../analysis/analyze.js";

export type DatasetKey =
  | "sitemap-table"
  | "sitemap-tree"
  | "pages"
  | "links"
  | "errors"
  | "redirects"
  | "orphans";

export interface Dataset {
  key: DatasetKey;
  sheet: string;
  headers: string[];
  rows: (string | number)[][];
  /** Excel専用のレイアウト（階層を列分割し、縦結合する場合に使用。CSVは headers/rows をそのまま使う） */
  excel?: {
    headers: string[];
    rows: (string | number)[][];
    /** 0始まりの列番号・データ行番号（ヘッダー行を除く）で指定する縦結合範囲 */
    merges: { col: number; rowStart: number; rowEnd: number }[];
  };
}

const lastSeg = (u: string) => (u === "/" ? "/" : u.replace(/\/$/, "").split("/").pop() || "/");
const issuesText = (issues: string[]) => issues.map((i) => ISSUE_LABEL_JP[i as Issue] ?? i).join(" / ");

export interface DatasetSource {
  pages: PageDTO[];
  tree: PageTreeNode | null;
  edges: CrawledEdge[];
  crawl: CrawlDTO;
}

function buildSitemapTable(src: DatasetSource): Dataset {
  return {
    key: "sitemap-table",
    sheet: "サイトマップ表",
    headers: ["URL", "タイトル", "ステータス", "階層", "親URL", "子ページ数", "被リンク", "問題"],
    rows: src.pages.map((p) => {
      const childCount = src.pages.filter((c) => c.parent === p.id).length;
      return [p.url, p.title, p.status, p.depth, p.parent ?? "（ルート）", childCount, p.inLinks, issuesText(p.issues)];
    }),
  };
}

const TREE_VBAR = "│　";
const TREE_GAP = "　　";

function nodeLabel(n: PageTreeNode): string {
  return n.h1 || n.title || lastSeg(n.url);
}

/** ├─ / └─ / │ を使った本格的なツリー罫線で各ノードを訪問順に並べる（祖先が「最後の子」かどうかで │ と空白を出し分ける） */
function walkTreeLines(root: PageTreeNode): { node: PageTreeNode; line: string }[] {
  const out: { node: PageTreeNode; line: string }[] = [];
  const walk = (n: PageTreeNode, prefix: string, branch: string) => {
    out.push({ node: n, line: prefix + branch + nodeLabel(n) });
    const children = n.children || [];
    const childPrefix = branch === "" ? prefix : prefix + (branch === "└" ? TREE_GAP : TREE_VBAR);
    children.forEach((c, i) => walk(c, childPrefix, i === children.length - 1 ? "└" : "├"));
  };
  walk(root, "", "");
  return out;
}

function buildSitemapTree(src: DatasetSource): Dataset {
  if (!src.tree) {
    return { key: "sitemap-tree", sheet: "サイトマップ階層", headers: ["階層", "構造", "URL", "ステータス", "問題"], rows: [] };
  }

  const ordered = walkTreeLines(src.tree);
  const rows = ordered.map(({ node: n, line }) => [n.depth, line, n.url, n.status, issuesText(n.issues)]);

  // ---- Excel専用: 階層ごとに列を分け、各ノードの行範囲を縦結合する ----
  const maxDepth = ordered.reduce((m, { node: n }) => Math.max(m, n.depth), 0);
  const levelHeaders = Array.from({ length: maxDepth + 1 }, (_, i) => `階層${i + 1}`);
  const excelHeaders = [...levelHeaders, "URL", "ステータス", "問題"];

  const rowIndexOf = new Map<PageTreeNode, number>();
  const spanOf = new Map<PageTreeNode, number>();
  let cursor = 0;
  const measure = (n: PageTreeNode): number => {
    rowIndexOf.set(n, cursor++);
    let span = 1;
    for (const c of n.children || []) span += measure(c);
    spanOf.set(n, span);
    return span;
  };
  measure(src.tree);

  const excelRows = ordered.map(({ node: n }) => {
    const levels = Array.from({ length: maxDepth + 1 }, (_, i) => (i === n.depth ? nodeLabel(n) : ""));
    return [...levels, n.url, n.status, issuesText(n.issues)];
  });

  const merges: { col: number; rowStart: number; rowEnd: number }[] = [];
  for (const { node: n } of ordered) {
    const span = spanOf.get(n) ?? 1;
    if (span > 1) {
      const start = rowIndexOf.get(n)!;
      merges.push({ col: n.depth, rowStart: start, rowEnd: start + span - 1 });
    }
  }

  return {
    key: "sitemap-tree",
    sheet: "サイトマップ階層",
    headers: ["階層", "構造", "URL", "ステータス", "問題"],
    rows,
    excel: { headers: excelHeaders, rows: excelRows, merges },
  };
}

function buildPages(src: DatasetSource): Dataset {
  return {
    key: "pages",
    sheet: "ページ",
    headers: ["URL", "ステータス", "タイトル", "H1", "階層", "正規URL", "Noindex", "被リンク", "発リンク", "単語数", "サイズKB", "問題"],
    rows: src.pages.map((p) => [
      p.url,
      p.status,
      p.title,
      p.h1,
      p.depth,
      p.canonical === "self" ? p.url : p.canonical,
      p.noindex ? "noindex" : "index",
      p.inLinks,
      p.outLinks,
      p.words,
      p.size,
      issuesText(p.issues),
    ]),
  };
}

function buildLinks(src: DatasetSource): Dataset {
  const byId = new Map(src.pages.map((p) => [p.id, p]));
  return {
    key: "links",
    sheet: "リンク",
    headers: ["リンク元URL", "リンク先URL", "種別", "元ステータス", "先ステータス"],
    rows: src.edges
      .filter((e) => byId.has(e.s) && byId.has(e.t))
      .map((e) => {
        const s = byId.get(e.s)!;
        const t = byId.get(e.t)!;
        return [s.url, t.url, EDGE_TYPE_JP[e.type] ?? e.type, s.status, t.status];
      }),
  };
}

function buildErrors(src: DatasetSource): Dataset {
  const errs = src.pages.filter((p) => [404, 410, 500].includes(p.status));
  return {
    key: "errors",
    sheet: "エラー",
    headers: ["URL", "ステータス", "種別", "被リンク", "階層"],
    rows: errs.map((p) => [p.url, p.status, STATUS_JP[p.status] ?? "", p.inLinks, p.depth]),
  };
}

function buildRedirects(src: DatasetSource): Dataset {
  const chains = buildRedirectChains(src.pages);
  const byUrl = new Map(chains.map((c) => [c.from, c]));
  const all = src.pages.filter((p) => [301, 302].includes(p.status));
  return {
    key: "redirects",
    sheet: "リダイレクト",
    headers: ["リンク元URL", "リダイレクト先", "ステータス", "チェーン深さ"],
    rows: all.map((p) => [p.url, p.redirectTo || "", p.status, byUrl.get(p.url)?.depth ?? 1]),
  };
}

function buildOrphans(src: DatasetSource): Dataset {
  const orphans = src.pages.filter((p) => p.issues.includes("orphan"));
  return {
    key: "orphans",
    sheet: "孤立ページ",
    headers: ["URL", "ステータス", "タイトル", "被リンク", "Noindex", "孤立の理由", "階層"],
    rows: orphans.map((p) => [p.url, p.status, p.title, p.inLinks, p.noindex ? "noindex" : "index", orphanReason(p), p.depth]),
  };
}

const BUILDERS: Record<DatasetKey, (src: DatasetSource) => Dataset> = {
  "sitemap-table": buildSitemapTable,
  "sitemap-tree": buildSitemapTree,
  pages: buildPages,
  links: buildLinks,
  errors: buildErrors,
  redirects: buildRedirects,
  orphans: buildOrphans,
};

export const ALL_DATASET_KEYS: DatasetKey[] = ["sitemap-table", "sitemap-tree", "pages", "links", "errors", "redirects", "orphans"];

export function buildDataset(key: DatasetKey, src: DatasetSource): Dataset {
  return BUILDERS[key](src);
}

export function buildDatasets(keys: DatasetKey[], src: DatasetSource): Dataset[] {
  return keys.map((k) => buildDataset(k, src));
}
