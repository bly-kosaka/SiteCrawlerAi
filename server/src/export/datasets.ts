import type { PageDTO, PageTreeNode, CrawlDTO } from "../serialize.js";
import type { EdgeRow } from "./edges.js";
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

export type Row = (string | number)[];

export interface Dataset {
  key: DatasetKey;
  sheet: string;
  headers: string[];
  /**
   * データ行をバッチ単位で返す（呼ぶたびに先頭から列挙し直せる）。
   * 「リンク」は行数がページ数×リンク数規模になるため、全行を配列として持たずに DB から
   * バッチ単位で読みながら返す。その他のデータセットは行数がページ数以下なので1バッチで返す。
   */
  rows: () => AsyncIterable<Row[]>;
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
  // edges をバッチ単位で返す（呼ぶたびに先頭から読み直す）。「リンク」以外では呼ばれない
  edgeBatches: () => AsyncIterable<EdgeRow[]>;
  crawl: CrawlDTO;
}

// 配列をそのまま1バッチとして返す rows 関数を作る
function fromArray(rows: Row[]): () => AsyncIterable<Row[]> {
  return async function* () {
    yield rows;
  };
}

function buildSitemapTable(src: DatasetSource): Dataset {
  // 子ページ数は事前に親 id ごとに数えておく（以前はページごとに全ページを走査しており、
  // ページ数の2乗の計算量になっていた。結果は同じ）
  const childCount = new Map<string, number>();
  for (const c of src.pages) if (c.parent) childCount.set(c.parent, (childCount.get(c.parent) ?? 0) + 1);
  return {
    key: "sitemap-table",
    sheet: "サイトマップ表",
    headers: ["URL", "タイトル", "ステータス", "階層", "親URL", "子ページ数", "被リンク", "問題"],
    rows: fromArray(
      src.pages.map((p) => [p.url, p.title, p.status, p.depth, p.parent ?? "（ルート）", childCount.get(p.id) ?? 0, p.inLinks, issuesText(p.issues)])
    ),
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
    return { key: "sitemap-tree", sheet: "サイトマップ階層", headers: ["階層", "構造", "URL", "ステータス", "問題"], rows: fromArray([]) };
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
    rows: fromArray(rows),
    excel: { headers: excelHeaders, rows: excelRows, merges },
  };
}

function buildPages(src: DatasetSource): Dataset {
  return {
    key: "pages",
    sheet: "ページ",
    headers: ["URL", "ステータス", "タイトル", "H1", "階層", "正規URL", "Noindex", "被リンク", "発リンク", "単語数", "サイズKB", "問題"],
    rows: fromArray(src.pages.map((p) => [
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
    ])),
  };
}

function buildLinks(src: DatasetSource): Dataset {
  const byId = new Map(src.pages.map((p) => [p.id, p]));
  return {
    key: "links",
    sheet: "リンク",
    headers: ["リンク元URL", "リンク先URL", "種別", "元ステータス", "先ステータス"],
    // edges は全件を配列にせず、DB からバッチ単位で読みながら行に変換する
    rows: async function* () {
      for await (const batch of src.edgeBatches()) {
        const rows: Row[] = [];
        for (const e of batch) {
          const s = byId.get(e.s);
          const t = byId.get(e.t);
          if (!s || !t) continue;
          rows.push([s.url, t.url, EDGE_TYPE_JP[e.type] ?? e.type, s.status, t.status]);
        }
        yield rows;
      }
    },
  };
}

function buildErrors(src: DatasetSource): Dataset {
  const errs = src.pages.filter((p) => [404, 410, 500].includes(p.status));
  return {
    key: "errors",
    sheet: "エラー",
    headers: ["URL", "ステータス", "種別", "被リンク", "階層"],
    rows: fromArray(errs.map((p) => [p.url, p.status, STATUS_JP[p.status] ?? "", p.inLinks, p.depth])),
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
    rows: fromArray(all.map((p) => [p.url, p.redirectTo || "", p.status, byUrl.get(p.url)?.depth ?? 1])),
  };
}

function buildOrphans(src: DatasetSource): Dataset {
  const orphans = src.pages.filter((p) => p.issues.includes("orphan"));
  return {
    key: "orphans",
    sheet: "孤立ページ",
    headers: ["URL", "ステータス", "タイトル", "被リンク", "Noindex", "孤立の理由", "階層"],
    rows: fromArray(orphans.map((p) => [p.url, p.status, p.title, p.inLinks, p.noindex ? "noindex" : "index", orphanReason(p), p.depth])),
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
