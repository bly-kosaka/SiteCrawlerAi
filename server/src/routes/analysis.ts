import type { FastifyInstance } from "fastify";
import { iterateEdges } from "../export/edges.js";
import { streamBody } from "../export/stream.js";
import { prisma } from "../db.js";
import { toPageDTO, buildTree, type PageDTO } from "../serialize.js";
import { computeSummary, buildRedirectChains, orphanReason, type AnalysisSummary } from "../analysis/analyze.js";

// クロール結果の保存はチャンク分割の順次書き込みで、保存が終わるまで status は "running" のまま
// （最後に "done" へ更新される）。保存途中に Page/Edge を読むと書きかけの結果を返してしまうため、
// "done" 以外（queued/running/error）のクロールでは行を一切読まず「結果なし」として扱う。
//  - 409 等のエラーにしない理由: フロントは実行中のクロールも loadSite で読み込む経路があり
//    （初回表示・クロール切替）、1本でも失敗すると Promise.all ごと失敗して画面が
//    「読み込み中…」のまま固まる。空結果なら各画面は従来の「データ未取得」表示になり、
//    完了 SSE("done") 受信後の再読込で結果が表示される。
//  - error のクロールは行が削除されるため、空で返しても内容は従来と変わらない。
type CrawlGate = "missing" | "pending" | "done";
async function crawlGate(crawlId: string): Promise<CrawlGate> {
  const crawl = await prisma.crawl.findUnique({ where: { id: crawlId }, select: { status: true } });
  if (!crawl) return "missing";
  return crawl.status === "done" ? "done" : "pending";
}

async function loadPages(crawlId: string): Promise<PageDTO[] | null> {
  const gate = await crawlGate(crawlId);
  if (gate === "missing") return null;
  if (gate === "pending") return [];
  const rows = await prisma.page.findMany({ where: { crawlId }, orderBy: { url: "asc" } });
  return rows.map(toPageDTO);
}

// /links の応答本文 {"edges":[{"s":..,"t":..,"type":..},...]} をバッチごとの文字列チャンクとして返す
async function* linksJsonChunks(crawlId: string): AsyncGenerator<string> {
  yield '{"edges":[';
  let first = true;
  for await (const batch of iterateEdges(crawlId)) {
    let chunk = "";
    for (const e of batch) {
      chunk += (first ? "" : ",") + JSON.stringify({ s: e.s, t: e.t, type: e.type });
      first = false;
    }
    yield chunk;
  }
  yield "]}";
}

// SQLite のバインド変数上限（古いビルドでは 999）を超えないよう、IN 句は分割して発行する
const IN_CHUNK = 500;
type LinkedFromRow = { id: string; url: string; title: string; h1: string; status: number };

// ソート可能なキーを明示的に許可リスト化する。
// 任意の文字列キーを許すと、存在しないプロパティへのアクセスや (オブジェクト型の)
// 比較不能な値でのソートを許してしまい、`as any` キャストで型チェックも素通りしてしまう。
const SORTABLE_KEYS = new Set<keyof PageDTO>([
  "url", "status", "title", "h1", "depth", "inLinks", "outLinks", "words", "size",
]);
function isSortableKey(key: string): key is keyof PageDTO {
  return SORTABLE_KEYS.has(key as keyof PageDTO);
}

function applyListQuery(pages: PageDTO[], query: Record<string, unknown>): PageDTO[] {
  let rows = pages;
  const q = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
  if (q) {
    rows = rows.filter((p) => (p.url + " " + p.title + " " + p.h1).toLowerCase().includes(q));
  }
  if (typeof query.status === "string" && query.status) {
    const codes = query.status.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (codes.length) rows = rows.filter((p) => codes.includes(p.status));
  }
  const sort = typeof query.sort === "string" ? query.sort : null;
  if (sort && isSortableKey(sort)) {
    const order = query.order === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (typeof av === "string" || typeof bv === "string") {
        return order * String(av ?? "").localeCompare(String(bv ?? ""), "ja");
      }
      return order * ((Number(av) || 0) - (Number(bv) || 0));
    });
  }
  return rows;
}

export async function registerAnalysisRoutes(app: FastifyInstance) {
  app.get("/api/crawls/:id/pages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return applyListQuery(pages, req.query as Record<string, unknown>);
  });

  // 注: フロントは /pages の flat から自前でツリーを組み立てる（web/src/lib/common.ts buildTree）ため
  // 現在は未使用。外部からの利用に備えて互換のため残している。
  app.get("/api/crawls/:id/tree", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return buildTree(pages);
  });

  // リンクグラフ（edges のみ）。
  // 以前は nodes として全ページも同梱していたが、フロントは /pages で取得済みの flat を
  // 使うため不要（全ページの二重読み出し・二重転送になっていた）。edges も必要な列だけ select し、
  // Prisma エンジンが確保するメモリを抑える。リンク画面を開いたときにだけ呼ばれる（遅延取得）。
  app.get("/api/crawls/:id/links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const gate = await crawlGate(id);
    if (gate === "missing") return reply.code(404).send({ error: "not found" });
    if (gate === "pending") return { edges: [] };
    // 全 edges を一度に読み込んで JSON 文字列化すると、1万ページ規模（数十万行）では Prisma の結果配列・
    // オブジェクト配列・JSON 文字列が同時にメモリに載り、数百MBのピークになっていた。
    // そのため edges をバッチ単位で読みながら、{"edges":[...]} を逐次書き出す（JSON としての内容と
    // 要素の並び順・キー順は以前の一括応答と同じ）。クライアントが途中で切断したら読み出しも止める。
    // エクスポートの直列化には入れない（メモリはバッチ分しか使わず、リンク画面の表示を待たせないため）。
    const body = streamBody(reply, linksJsonChunks(id), `/links (crawl=${id})`);
    return reply.type("application/json; charset=utf-8").send(body);
  });

  // edges の件数のみ（エクスポート画面の「リンク N 行」表示用）。
  // 件数のためだけに全 edges を転送しないよう COUNT で返す。
  app.get("/api/crawls/:id/links/count", async (req, reply) => {
    const { id } = req.params as { id: string };
    const gate = await crawlGate(id);
    if (gate === "missing") return reply.code(404).send({ error: "not found" });
    if (gate === "pending") return { count: 0 };
    const count = await prisma.edge.count({ where: { crawlId: id } });
    return { count };
  });

  // ページ詳細。以前は全ページを読み込んでから対象を探していたが、
  // 対象ページ・そのページへの被リンク edges・リンク元ページだけを where 句で引く。
  app.get("/api/crawls/:id/pages/:pageId", async (req, reply) => {
    const { id, pageId } = req.params as { id: string; pageId: string };
    // 404 の種別（クロール自体が無いのか、ページが無いのか）は従来どおり区別する。
    // 未完了クロールは「ページがまだ無い」扱い（一覧系が空を返すのと整合）。
    const gate = await crawlGate(id);
    if (gate === "missing") return reply.code(404).send({ error: "not found" });
    if (gate === "pending") return reply.code(404).send({ error: "page not found" });
    const row = await prisma.page.findUnique({ where: { crawlId_id: { crawlId: id, id: pageId } } });
    if (!row) return reply.code(404).send({ error: "page not found" });
    const page = toPageDTO(row);

    const edges = await prisma.edge.findMany({
      where: { crawlId: id, t: pageId, type: { not: "redirect" } },
      select: { s: true },
    });
    // リンク元 ID を出現順のまま重複排除（Set で O(n)）
    const sourceIds = [...new Set(edges.map((e) => e.s))];

    const byId = new Map<string, LinkedFromRow>();
    for (let i = 0; i < sourceIds.length; i += IN_CHUNK) {
      const rows = await prisma.page.findMany({
        where: { crawlId: id, id: { in: sourceIds.slice(i, i + IN_CHUNK) } },
        select: { id: true, url: true, title: true, h1: true, status: true },
      });
      for (const r of rows) byId.set(r.id, r);
    }
    const linkedFrom = sourceIds
      .map((sid) => byId.get(sid))
      .filter((p): p is LinkedFromRow => !!p)
      .map((p) => ({ url: p.url, title: p.title || p.h1, status: p.status }));

    return { ...page, linkedFrom };
  });

  app.get("/api/crawls/:id/issues/errors", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return pages.filter((p) => [404, 410, 500].includes(p.status));
  });

  app.get("/api/crawls/:id/issues/redirects", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return buildRedirectChains(pages);
  });

  app.get("/api/crawls/:id/issues/orphans", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return pages
      .filter((p) => p.issues.includes("orphan"))
      .map((p) => ({ ...p, reason: orphanReason(p) }));
  });

  app.get("/api/crawls/:id/summary", async (req, reply) => {
    const { id } = req.params as { id: string };
    const crawl = await prisma.crawl.findUnique({ where: { id } });
    if (!crawl) return reply.code(404).send({ error: "not found" });

    // 完了済みクロールはクロール終了時に確定した値が crawl 行に永続化されているため、
    // 毎回 pages 全件を読み込んで再計算する必要がない（M-2: フルスキャン回避）。
    // error のクロールも従来どおり crawl 行の値を返す。
    // 実行中(running/queued)は、以前は pages を読んで途中経過を計算していたが、保存途中の
    // 書きかけの行を読むことになるため読まずに空の集計を返す（loadPages のガードと同じ方針）。
    if (crawl.status === "running" || crawl.status === "queued") {
      return computeSummary([]);
    }
    const summary: AnalysisSummary = {
      pages: crawl.pages,
      ok: crawl.ok,
      errors: crawl.errors,
      redirects: crawl.redirects,
      orphans: crawl.orphans,
      noindex: crawl.noindex,
      dupTitles: crawl.dup,
      dupH1s: crawl.dupH1s,
      health: crawl.health,
    };
    return summary;
  });
}
