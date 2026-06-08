import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { toCrawlDTO } from "../serialize.js";
import { startCrawl, recrawl, crawlEvents, isRunning, StartCrawlValidationError } from "../crawler/manager.js";

// startUrl はこの時点では「形式」だけを検証する(URLとしてパース可能 かつ http/https スキームか)。
// プライベートIP/メタデータ等への到達可否はDNS解決を伴うため、ここでは行わず
// crawler/ssrf.ts の assertSafeStartUrl(startCrawl 内で呼び出し)に委譲する。
// 形式チェックを先に行うことで、無効な値に対して明確な400エラーを早期に返せる。
const startUrlSchema = z
  .string()
  .min(1)
  .url("有効なURL形式ではありません")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "http または https のURLを指定してください");

const createSchema = z.object({
  startUrl: startUrlSchema,
  maxDepth: z.number().int().min(0).max(10).default(3),
  label: z.string().optional(),
  render: z.boolean().optional(),
});

const patchSchema = z.object({
  label: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

// 「どのクロール結果を見ているか」はブラウザ単位で Cookie に保持する。
// これにより、同じサーバーを使う複数ユーザーがそれぞれ別のクロール結果を参照できる。
const ACTIVE_COOKIE = "scai_active";
// この値はサーバー側でのみ参照し、フロントエンドのJSからは読まないため httpOnly にできる。
// secure は本番(HTTPS)でのみ有効化する(http://localhost での開発時に保存されなくなるため)。
const ACTIVE_COOKIE_OPTS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};

function withCookieActive<T extends { id: string; active: boolean }>(dto: T, cookieActiveId: string | null): T {
  if (cookieActiveId === null) return dto;
  return dto.id === cookieActiveId ? { ...dto, active: true } : { ...dto, active: false };
}

export async function registerCrawlRoutes(app: FastifyInstance) {
  app.get("/api/crawls", async (req) => {
    const rows = await prisma.crawl.findMany({ orderBy: { createdAt: "desc" } });
    const cookieActiveId = req.cookies?.[ACTIVE_COOKIE] ?? null;
    return rows.map((r) => withCookieActive(toCrawlDTO(r), cookieActiveId));
  });

  app.post("/api/crawls", {
    // クロール起動はChromiumプロセス起動を伴う重い処理のため、グローバルのレート制限より厳しく絞る
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const { id } = await startCrawl(parsed.data);
      return reply.code(202).send({ id, status: "running" });
    } catch (err) {
      if (err instanceof StartCrawlValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/api/crawls/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.crawl.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: "not found" });
    const cookieActiveId = req.cookies?.[ACTIVE_COOKIE] ?? null;
    return withCookieActive(toCrawlDTO(row), cookieActiveId);
  });

  app.get("/api/crawls/:id/progress", async (req, reply) => {
    const { id } = req.params as { id: string };
    const crawl = await prisma.crawl.findUnique({ where: { id } });
    if (!crawl) return reply.code(404).send({ error: "not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!isRunning(id)) {
      send(crawl.status === "done" ? "done" : "status", { id, status: crawl.status });
      reply.raw.end();
      return;
    }

    const onEvent = (evt: { type: string; data: unknown }) => {
      send(evt.type, evt.data);
      if (evt.type === "done" || evt.type === "error") {
        cleanup();
        reply.raw.end();
      }
    };
    const cleanup = () => crawlEvents.off(id, onEvent);
    crawlEvents.on(id, onEvent);
    req.raw.on("close", cleanup);
  });

  app.patch("/api/crawls/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const existing = await prisma.crawl.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not found" });

    let cookieActiveId = req.cookies?.[ACTIVE_COOKIE] ?? null;
    if (parsed.data.active) {
      await prisma.crawl.updateMany({ where: { id: { not: id } }, data: { active: false } });
      reply.setCookie(ACTIVE_COOKIE, id, ACTIVE_COOKIE_OPTS);
      cookieActiveId = id;
    }
    const updated = await prisma.crawl.update({ where: { id }, data: parsed.data });
    return withCookieActive(toCrawlDTO(updated), cookieActiveId);
  });

  app.delete("/api/crawls/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.crawl.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not found" });
    await prisma.crawl.delete({ where: { id } });
    if (req.cookies?.[ACTIVE_COOKIE] === id) reply.clearCookie(ACTIVE_COOKIE, { path: "/" });
    // 全体のデフォルトだったクロールを削除した場合、最新の残りを新たなデフォルトにする
    if (existing.active) {
      const next = await prisma.crawl.findFirst({ orderBy: { createdAt: "desc" } });
      if (next) await prisma.crawl.update({ where: { id: next.id }, data: { active: true } });
    }
    return reply.code(204).send();
  });

  app.post("/api/crawls/:id/recrawl", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await recrawl(id);
      if (!result) return reply.code(404).send({ error: "not found" });
      return reply.code(202).send({ id: result.id, status: "running" });
    } catch (err) {
      if (err instanceof StartCrawlValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
