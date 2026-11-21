import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export interface EdgeRow {
  s: string;
  t: string;
  type: string;
}

// 1回の問い合わせで読む edges の行数。全件を一度に読むと Prisma エンジンと V8 の双方に
// 「全 edges 分」の配列が載り（1万ページ規模で数十万行）、メモリのピークが数百MB増えるため、
// この行数ずつのバッチに分けて読み、呼び出し側が書き出し終えたバッチは参照を捨てられるようにする。
export const EDGE_READ_BATCH = 5000;

/**
 * 指定クロールの edges を「リンク先 t → 行 id」順に、batchSize 件ずつのバッチで返す。
 *
 * - 並び順は、以前の一括読み出し（orderBy 指定なし）で SQLite が Edge_crawlId_t_idx を使って返していた順と同じ。
 *   リンク一覧 API・リンク CSV/シートの行順を変えないため、この順を明示している。
 * - 続きの読み出しは OFFSET ではなく直前の (t, id) より後ろを読む keyset 方式（行値比較）で行う。
 *   同じインデックスの範囲検索になるため、後半のバッチほど遅くなることがない。
 *   （Prisma の where では行値比較を書けないため、パラメータ化した生 SQL を使う）
 * - 呼び出し側がループを途中で抜けると（ジェネレーターの return）、以降の読み出しは行わない。
 */
export async function* iterateEdges(crawlId: string, batchSize = EDGE_READ_BATCH): AsyncGenerator<EdgeRow[]> {
  let last: { t: string; id: number } | null = null;
  while (true) {
    const after: Prisma.Sql = last ? Prisma.sql`AND (t, id) > (${last.t}, ${last.id})` : Prisma.empty;
    const rows: { id: number; s: string; t: string; type: string }[] = await prisma.$queryRaw`
      SELECT id, s, t, type FROM Edge
      WHERE crawlId = ${crawlId} ${after}
      ORDER BY t, id
      LIMIT ${batchSize}`;
    if (!rows.length) return;
    const tail = rows[rows.length - 1];
    last = { t: tail.t, id: Number(tail.id) };
    yield rows.map((r) => ({ s: r.s, t: r.t, type: r.type }));
    if (rows.length < batchSize) return;
  }
}
