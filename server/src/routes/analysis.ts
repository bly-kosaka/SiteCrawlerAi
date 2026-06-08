import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { toPageDTO, buildTree, type PageDTO } from "../serialize.js";
import { computeSummary, buildRedirectChains, orphanReason, type AnalysisSummary } from "../analysis/analyze.js";

async function loadPages(crawlId: string): Promise<PageDTO[] | null> {
  const crawl = await prisma.crawl.findUnique({ where: { id: crawlId } });
  if (!crawl) return null;
  const rows = await prisma.page.findMany({ where: { crawlId }, orderBy: { url: "asc" } });
  return rows.map(toPageDTO);
}

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

  app.get("/api/crawls/:id/tree", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return buildTree(pages);
  });

  app.get("/api/crawls/:id/links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const crawl = await prisma.crawl.findUnique({ where: { id } });
    if (!crawl) return reply.code(404).send({ error: "not found" });
    const [pages, edges] = await Promise.all([
      prisma.page.findMany({ where: { crawlId: id } }),
      prisma.edge.findMany({ where: { crawlId: id } }),
    ]);
    return {
      nodes: pages.map(toPageDTO),
      edges: edges.map((e) => ({ s: e.s, t: e.t, type: e.type })),
    };
  });

  app.get("/api/crawls/:id/pages/:pageId", async (req, reply) => {
    const { id, pageId } = req.params as { id: string; pageId: string };
    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    const page = pages.find((p) => p.id === pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });

    const edges = await prisma.edge.findMany({ where: { crawlId: id, t: pageId, type: { not: "redirect" } } });
    const byId = new Map(pages.map((p) => [p.id, p]));
    const linkedFrom = edges
      .map((e) => byId.get(e.s))
      .filter((p): p is PageDTO => !!p)
      .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
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
    // 実行中クロールのみ、その時点までの途中経過を見せるために都度計算する。
    if (crawl.status !== "running") {
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
    }

    const pages = await loadPages(id);
    if (!pages) return reply.code(404).send({ error: "not found" });
    return computeSummary(pages);
  });
}
