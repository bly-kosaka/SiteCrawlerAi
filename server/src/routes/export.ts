import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { toPageDTO, toCrawlDTO, buildTree } from "../serialize.js";
import { ALL_DATASET_KEYS, buildDataset, buildDatasets, type DatasetKey, type DatasetSource } from "../export/datasets.js";
import { toCsv, toXlsxBuffer } from "../export/writers.js";

async function loadSource(crawlId: string): Promise<DatasetSource | null> {
  const crawl = await prisma.crawl.findUnique({ where: { id: crawlId } });
  if (!crawl) return null;
  const [pageRows, edgeRows] = await Promise.all([
    prisma.page.findMany({ where: { crawlId }, orderBy: { url: "asc" } }),
    prisma.edge.findMany({ where: { crawlId } }),
  ]);
  const pages = pageRows.map(toPageDTO);
  return {
    pages,
    tree: buildTree(pages),
    edges: edgeRows.map((e) => ({ s: e.s, t: e.t, type: e.type as any })),
    crawl: toCrawlDTO(crawl),
  };
}

function isDatasetKey(v: string): v is DatasetKey {
  return (ALL_DATASET_KEYS as string[]).includes(v);
}

export async function registerExportRoutes(app: FastifyInstance) {
  // まとめて Excel（複数シート）
  app.get("/api/crawls/:id/export.xlsx", async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = await loadSource(id);
    if (!src) return reply.code(404).send({ error: "not found" });

    const q = req.query as { datasets?: string };
    let keys = ALL_DATASET_KEYS;
    if (q.datasets) {
      const requested = q.datasets.split(",").map((s) => s.trim()).filter(isDatasetKey);
      if (requested.length) keys = requested;
    }

    const datasets = buildDatasets(keys, src);
    const buf = await toXlsxBuffer(datasets);
    reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="export_${src.crawl.host}.xlsx"`)
      .send(buf);
  });

  // 個別 CSV（URL: /api/crawls/:id/export/<dataset>.csv）
  app.get("/api/crawls/:id/export/:datasetFile", async (req, reply) => {
    const { id, datasetFile } = req.params as { id: string; datasetFile: string };
    const m = /^(.+)\.csv$/.exec(datasetFile);
    if (!m) return reply.code(400).send({ error: "expected <dataset>.csv" });
    const dataset = m[1];
    if (!isDatasetKey(dataset)) return reply.code(400).send({ error: "unknown dataset" });
    const src = await loadSource(id);
    if (!src) return reply.code(404).send({ error: "not found" });

    const ds = buildDataset(dataset, src);
    const csv = toCsv(ds);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${ds.key}_${src.crawl.host}.csv"`)
      .send(csv);
  });
}
