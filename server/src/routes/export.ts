import { mkdir, open, readdir, rm, rmdir, stat, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "../db.js";
import { toPageDTO, toCrawlDTO, buildTree } from "../serialize.js";
import { ALL_DATASET_KEYS, buildDataset, buildDatasets, type DatasetKey, type DatasetSource } from "../export/datasets.js";
import { csvChunks, writeXlsxFile, ExportAbortedError } from "../export/writers.js";
import { iterateEdges } from "../export/edges.js";
import { streamBody } from "../export/stream.js";

// クロール結果の保存はチャンク分割の順次書き込みで、保存が終わるまで status は "running" のまま
// （最後に "done" へ更新される）。保存途中に読むと書きかけのデータを出力してしまうため、
// "done" 以外のクロールでは行を一切読まずに 409 を返す（routes/analysis.ts のガードと同じ方針。
// こちらはダウンロードなので、空ファイルより理由が分かるエラーの方が誤解が少ない）。
type SourceResult =
  | { kind: "missing" }
  | { kind: "notReady"; status: string }
  | { kind: "ok"; src: DatasetSource };

function notReadyMessage(status: string): string {
  return status === "error"
    ? "このクロールはエラーで終了したため、エクスポートできるデータがありません。"
    : "クロールが完了していないため、エクスポートできません。完了してからもう一度お試しください。";
}

// 出力するデータセットが edges / tree を必要とするか。
// edges は「リンク」、tree は「サイトマップ階層」だけが使う（export/datasets.ts の各 build 関数参照）。
// それ以外のデータセットだけを出力する場合に Edge 全件の読み込みとツリー構築を省くための判定。
function needsOf(keys: DatasetKey[]): { edges: boolean; tree: boolean } {
  return { edges: keys.includes("links"), tree: keys.includes("sitemap-tree") };
}

async function loadSource(crawlId: string, keys: DatasetKey[]): Promise<SourceResult> {
  const crawl = await prisma.crawl.findUnique({ where: { id: crawlId } });
  if (!crawl) return { kind: "missing" };
  if (crawl.status !== "done") return { kind: "notReady", status: crawl.status };
  const need = needsOf(keys);
  const pageRows = await prisma.page.findMany({ where: { crawlId }, orderBy: { url: "asc" } });
  const pages = pageRows.map(toPageDTO);
  return {
    kind: "ok",
    src: {
      pages,
      // tree を使わないデータセットでは組み立てない（参照されない）
      tree: need.tree ? buildTree(pages) : null,
      // edges は全件を読み込まず、書き出し側が必要になった時点でバッチ単位で読む（「リンク」のみが呼ぶ）。
      // 並び順は従来どおり「リンク先 t → 行 id」順（export/edges.ts 参照）
      edgeBatches: () => iterateEdges(crawlId),
      crawl: toCrawlDTO(crawl),
    },
  };
}

// ---- エクスポートの直列化 ----
// エクスポートは対象クロールの全ページ（＋必要なら全 edges）を読み込んでファイルを組み立てるため、
// 大規模なクロールでは1本あたりのメモリ使用量が大きい。複数のエクスポートが同時に走ると
// そのピークが重なってヒープ上限を超え得るため、サーバー全体で1本ずつ順番に処理する。
// 待ち行列が長すぎる場合・待ち時間が長すぎる場合は 503（Retry-After 付き）で断る。
const EXPORT_MAX_WAITING = 3; // 実行中の1本とは別に待てる数
const EXPORT_WAIT_TIMEOUT_MS = 60_000; // これ以上待たされたら諦める
const EXPORT_RETRY_AFTER_SEC = 10;

let exportBusy = false;
const exportWaiters: (() => void)[] = [];

class ExportBusyError extends Error {}

// 実行権を得るまで待ち、解放関数を返す。待てない場合は ExportBusyError
async function acquireExportSlot(): Promise<() => void> {
  if (exportBusy) {
    if (exportWaiters.length >= EXPORT_MAX_WAITING) throw new ExportBusyError("queue full");
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = exportWaiters.indexOf(wake);
        if (i >= 0) exportWaiters.splice(i, 1);
        reject(new ExportBusyError("timeout"));
      }, EXPORT_WAIT_TIMEOUT_MS);
      exportWaiters.push(wake);
    });
    // 解放側から実行権を直接引き継いでいる（exportBusy は true のまま）
  } else {
    exportBusy = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = exportWaiters.shift();
    if (next) next(); // 実行権を次の待ちへ直接引き継ぐ（その間に割り込まれないように）
    else exportBusy = false;
  };
}

// 待ち行列に並ぶ前に、出力できないクロール（404 / 409）を即座に断るための軽い事前確認。
// 待っている間に状態が変わることもあるため、実行権を得た後の loadSource でも改めて確認する。
async function precheck(crawlId: string): Promise<SourceResult | null> {
  const crawl = await prisma.crawl.findUnique({ where: { id: crawlId }, select: { status: true } });
  if (!crawl) return { kind: "missing" };
  if (crawl.status !== "done") return { kind: "notReady", status: crawl.status };
  return null;
}

// 直列化した上で fn を実行する。混雑で実行できない場合は 503 を返す。
// 実行権は fn の終了時に解放する。ただし fn が応答をストリームで返す場合は、fn の中で slot.hold() を呼び、
// 返された解放関数をストリームの終了（正常終了・切断・エラーのいずれも）時に呼ぶ。
interface ExportSlot {
  hold(): () => void;
}
async function withExportSlot(reply: FastifyReply, fn: (slot: ExportSlot) => Promise<unknown>) {
  let release: () => void;
  try {
    release = await acquireExportSlot();
  } catch (err) {
    if (err instanceof ExportBusyError) {
      return reply
        .code(503)
        .header("Retry-After", String(EXPORT_RETRY_AFTER_SEC))
        .send({ error: "エクスポートが混み合っています。しばらくしてからもう一度お試しください。" });
    }
    throw err;
  }
  let held = false;
  try {
    return await fn({
      hold: () => {
        held = true;
        return release;
      },
    });
  } catch (err) {
    held = false;
    throw err;
  } finally {
    if (!held) release();
  }
}

// xlsx を書き出す一時ファイルの置き場所。xlsx はメモリ上で組み立てず一時ファイルへ書き出してから送る
// （書き出しの途中で失敗した場合に、ヘッダー送信前なので通常のエラー応答を返せるため）。
// ディレクトリはプロセスごとに分ける。以前は全プロセス共通の「sitecrawler-export」を起動時に丸ごと
// 空にしていたため、同じ一時ディレクトリを使う別のサーバープロセス（開発機で複数起動した場合など）が
// 起動すると、書き出し中・送信直前のファイルが消されてエクスポートが 500 になっていた。
const EXPORT_TMP_PREFIX = "sitecrawler-export";
const EXPORT_TMP_DIR = path.join(os.tmpdir(), `${EXPORT_TMP_PREFIX}-${process.pid}`);
// 他プロセスのディレクトリ（と旧版の共通ディレクトリ）の残骸を掃除する際、これより新しいものは
// 使用中の可能性があるため触らない。xlsx の書き出しは数秒〜数十秒で、書き出し中はファイルの更新時刻が進む。
const EXPORT_TMP_STALE_MS = 60 * 60 * 1000;

async function removeQuietly(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch (err: any) {
    console.error(`[export] 一時ファイルの削除に失敗しました: ${file}`, err?.message || err);
  }
}

// 更新時刻が olderThan より前のファイルだけを消し、ディレクトリ自体も古くて空なら消す
async function removeStaleFiles(dir: string, olderThan: number): Promise<void> {
  // ディレクトリが古いかどうかは中のファイルを消す前に判定する（消すとディレクトリの更新時刻が進むため）。
  // 使用中のプロセスはファイルを作る・消すたびにディレクトリの更新時刻が進むため、古いものだけを対象にする
  let dirIsStale = false;
  try {
    dirIsStale = (await stat(dir)).mtimeMs < olderThan;
  } catch {
    return;
  }
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (st.isFile() && st.mtimeMs < olderThan) await removeQuietly(file);
    } catch {
      // 調べている間に持ち主のプロセスが消した場合など。無視する
    }
  }
  try {
    if (dirIsStale) await rmdir(dir); // 空でなければ失敗する（無視）
  } catch {
    // 空でない・既に無い等。無視する
  }
}

// 起動時の掃除。
//  - 自分のディレクトリ（同じ pid の過去のプロセスの残骸。コンテナでは pid が毎回 1 になる）は中身を全部消す。
//    同じ pid のプロセスが同じ一時ディレクトリで同時に動くことは無いため、使用中のファイルは存在しない
//  - 他のプロセスのディレクトリと旧版の共通ディレクトリは、十分に古い（1時間以上更新の無い）残骸だけを消す
async function sweepTmpDir(): Promise<void> {
  try {
    await mkdir(EXPORT_TMP_DIR, { recursive: true });
    for (const name of await readdir(EXPORT_TMP_DIR)) await removeQuietly(path.join(EXPORT_TMP_DIR, name));
  } catch (err: any) {
    console.error("[export] 一時ディレクトリの準備に失敗しました:", err?.message || err);
  }
  try {
    const olderThan = Date.now() - EXPORT_TMP_STALE_MS;
    const ownName = path.basename(EXPORT_TMP_DIR);
    for (const ent of await readdir(os.tmpdir(), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === ownName) continue;
      if (ent.name !== EXPORT_TMP_PREFIX && !/^sitecrawler-export-\d+$/.test(ent.name)) continue;
      await removeStaleFiles(path.join(os.tmpdir(), ent.name), olderThan);
    }
  } catch (err: any) {
    console.error("[export] 古い一時ファイルの掃除に失敗しました:", err?.message || err);
  }
}

// 終了処理から呼ぶ。このプロセスの一時ディレクトリを消す（失敗してもログのみ）
export async function cleanupExportTmpDir(): Promise<void> {
  try {
    await rm(EXPORT_TMP_DIR, { recursive: true, force: true });
  } catch (err: any) {
    console.error("[export] 一時ディレクトリの削除に失敗しました:", err?.message || err);
  }
}

// エクスポートは GET でだけ受け付ける。Fastify は GET ルートに HEAD を自動で付けるが、HEAD でも
// ハンドラー全体（DB の読み出し・xlsx の書き出し）が走ってしまうため、HEAD は処理せず 405 を返す
// （フロントは GET の fetch でしか呼ばない）。
function rejectHead(reply: FastifyReply) {
  return reply.code(405).header("Allow", "GET").send({ error: "method not allowed" });
}

// loadSource の結果のうち、出力できないもの（404 / 409）を応答する。出力可能なら null
function rejectUnavailable(reply: FastifyReply, r: SourceResult) {
  if (r.kind === "missing") return reply.code(404).send({ error: "not found" });
  if (r.kind === "notReady") return reply.code(409).send({ error: notReadyMessage(r.status), status: r.status });
  return null;
}

function isDatasetKey(v: string): v is DatasetKey {
  return (ALL_DATASET_KEYS as string[]).includes(v);
}

export async function registerExportRoutes(app: FastifyInstance) {
  await sweepTmpDir();

  // まとめて Excel（複数シート）
  app.get("/api/crawls/:id/export.xlsx", async (req, reply) => {
    if (req.method === "HEAD") return rejectHead(reply);
    const { id } = req.params as { id: string };
    const q = req.query as { datasets?: string };
    let keys = ALL_DATASET_KEYS;
    if (q.datasets) {
      const requested = q.datasets.split(",").map((s) => s.trim()).filter(isDatasetKey);
      if (requested.length) keys = requested;
    }

    const pre = await precheck(id);
    if (pre) return rejectUnavailable(reply, pre);
    // 一時ファイルへの書き出しは直列化した実行権の中で行い、書き終えたら実行権を返してから送る
    // （送信はファイルからのストリームでメモリをほとんど使わないため）
    const file = path.join(EXPORT_TMP_DIR, `${randomBytes(8).toString("hex")}.xlsx`);
    let host = "";
    let aborted = false;
    const onClientClose = () => {
      if (!reply.raw.writableFinished) aborted = true;
    };
    reply.raw.once("close", onClientClose);
    try {
      const result = await withExportSlot(reply, async () => {
        const loaded = await loadSource(id, keys);
        if (loaded.kind !== "ok") return rejectUnavailable(reply, loaded);
        host = loaded.src.crawl.host;
        await mkdir(EXPORT_TMP_DIR, { recursive: true });
        await writeXlsxFile(buildDatasets(keys, loaded.src), file, () => aborted);
        return null;
      });
      if (result !== null) {
        await removeQuietly(file);
        return result; // 404 / 409 / 503 を応答済み
      }
    } catch (err) {
      await removeQuietly(file);
      if (err instanceof ExportAbortedError) {
        console.warn(`[export] クライアントが切断したため xlsx の書き出しを中断しました (crawl=${id})`);
        return reply; // 接続は既に閉じている
      }
      throw err;
    } finally {
      reply.raw.off("close", onClientClose);
    }
    if (aborted) {
      await removeQuietly(file);
      return reply;
    }
    // 先にファイルを開いてから、開いたハンドルでサイズを調べて送る（パスで stat してから開き直すと、
    // その間にファイルが消された場合に食い違うため）。開いた後はパスが消されても内容は読める。
    // ここでの失敗（ファイルが消された等）はヘッダー送信前なので、内部のパスを含まない固定文言で返す。
    let fh: FileHandle | undefined;
    let size: number;
    try {
      fh = await open(file, "r");
      size = (await fh.stat()).size;
    } catch (err: any) {
      req.log.error({ err }, "[export] 書き出した xlsx の一時ファイルを開けませんでした");
      await fh?.close().catch(() => {});
      await removeQuietly(file);
      return reply.code(500).send({ error: "エクスポートファイルの準備に失敗しました。もう一度お試しください。" });
    }
    const body = fh.createReadStream(); // 読み終わり・破棄時にハンドルも閉じる（autoClose）
    // 送信完了・切断・読み込みエラーのいずれでも一時ファイルを消す
    body.once("close", () => void removeQuietly(file));
    reply.raw.once("close", () => {
      if (!body.destroyed) body.destroy();
    });
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="export_${host}.xlsx"`)
      .header("Content-Length", String(size))
      .send(body);
  });

  // 個別 CSV（URL: /api/crawls/:id/export/<dataset>.csv）
  app.get("/api/crawls/:id/export/:datasetFile", async (req, reply) => {
    if (req.method === "HEAD") return rejectHead(reply);
    const { id, datasetFile } = req.params as { id: string; datasetFile: string };
    const m = /^(.+)\.csv$/.exec(datasetFile);
    if (!m) return reply.code(400).send({ error: "expected <dataset>.csv" });
    const dataset = m[1];
    if (!isDatasetKey(dataset)) return reply.code(400).send({ error: "unknown dataset" });
    const pre = await precheck(id);
    if (pre) return rejectUnavailable(reply, pre);
    return withExportSlot(reply, async (slot) => {
      const loaded = await loadSource(id, [dataset]);
      if (loaded.kind !== "ok") return rejectUnavailable(reply, loaded);
      const { src } = loaded;

      const ds = buildDataset(dataset, src);
      // CSV は行単位で生成しながら送る。実行権は送信が終わる（または切断される）まで保持する
      const body = streamBody(reply, csvChunks(ds), `${ds.key}.csv (crawl=${id})`, slot.hold());
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${ds.key}_${src.crawl.host}.csv"`)
        .send(body);
    });
  });
}
