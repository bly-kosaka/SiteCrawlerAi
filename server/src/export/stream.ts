import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";

// ---- ストリーミング応答 ----
// 応答本文のストリームを返す。クライアントが途中で切断したらストリームを破棄して
// （ジェネレーターの return → DB の読み出しも止まる）、onClose を呼ぶ。
// ヘッダー送信後に失敗した場合は、HTTP ステータスを変えられないため接続を切って（不完全な応答として）
// クライアントに失敗を伝え、原因はログに残す。
export function streamBody(
  reply: FastifyReply,
  chunks: AsyncIterable<string>,
  label: string,
  onClose: () => void = () => {}
): Readable {
  const body = Readable.from(
    (async function* () {
      try {
        yield* chunks;
      } catch (err: any) {
        console.error(`[stream] ${label} の書き出し中にエラーが発生したため接続を切断します:`, err?.stack || err?.message || err);
        throw err;
      }
    })(),
    { objectMode: false }
  );
  body.once("close", onClose);
  reply.raw.once("close", () => {
    if (!body.destroyed) body.destroy();
  });
  return body;
}
