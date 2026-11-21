import { createWriteStream } from "node:fs";
import ExcelJS from "exceljs";
import type { Dataset, Row } from "./datasets.js";

// CSV/Excel フォーミュラインジェクション（CSVインジェクション, CWE-1236）対策。
// クロール対象ページの title / h1 / URL 等は外部サイト側が自由に設定できる値であり、
// "=HYPERLINK(...)" や "=cmd|'/c calc'!A1" のような文字列をそのまま出力すると、
// 利用者が Excel 等で開いた際に数式として評価され、情報漏洩や任意コマンド実行に繋がり得る。
// 先頭が = + - @ およびタブ/CR の場合は強制的に文字列として扱わせるため ' を前置する
// （スプレッドシートソフトが「これはテキストです」と解釈する標準的な無害化方法）。
const FORMULA_LEADING = /^[=+\-@\t\r]/;
function neutralizeFormula(s: string): string {
  return FORMULA_LEADING.test(s) ? "'" + s : s;
}

// common.jsx の csvEscape / buildCSV と同等（BOM付き・改行 \r\n・必要時のみダブルクオート）
function csvEscape(v: string | number): string {
  const s = neutralizeFormula(String(v ?? ""));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// CSV を先頭から順に文字列チャンクとして返す（応答ストリームへそのまま流す用）。
// 出力は以前の toCsv（全行を連結した1つの文字列）とバイト単位で同じ:
//   BOM + ヘッダー行、以降は各行の前に CRLF（末尾に改行は付けない）。
// 全行を1つの文字列にすると「リンク」では数十MB規模の文字列と、その元になる行配列が同時にメモリに載るため、
// CSV_CHUNK_ROWS 行ごとのチャンクに分けて返す。
const CSV_CHUNK_ROWS = 1000;

export async function* csvChunks(ds: Dataset): AsyncGenerator<string> {
  yield "\uFEFF" + ds.headers.map(csvEscape).join(",");
  for await (const batch of ds.rows()) {
    for (let i = 0; i < batch.length; i += CSV_CHUNK_ROWS) {
      let chunk = "";
      const end = Math.min(batch.length, i + CSV_CHUNK_ROWS);
      for (let j = i; j < end; j++) chunk += "\r\n" + batch[j].map(csvEscape).join(",");
      yield chunk;
    }
  }
}

// Excel/CSV共通: 文字列セルのみ無害化する（数値・真偽値はそのまま）
function neutralizeRow(row: Row): Row {
  return row.map((v) => (typeof v === "string" ? neutralizeFormula(v) : v));
}

// Excel の1シートあたりの最大行数（ヘッダー行を含む）
export const XLSX_MAX_ROWS = 1_048_576;

export class ExportAbortedError extends Error {
  constructor() {
    super("エクスポートを中断しました（クライアントが切断）");
    this.name = "ExportAbortedError";
  }
}

/**
 * データセットを1シートずつ xlsx ファイルへストリーミング書き出しする。
 *
 * 以前は ExcelJS のメモリ上の Workbook に全シート（数十万行の「リンク」を含む）を組み立ててから
 * writeBuffer していたため、3,800ページ規模でも V8 ヒープ上限(512MB)を超えてプロセスごと落ちていた。
 * ここでは stream.xlsx.WorkbookWriter で行ごとに commit し、書き終えた行をメモリから捨てる。
 * - 列幅は従来どおり「ヘッダーと全行の文字数の最大 + 2（10〜48）」。列定義はシートの行より前に
 *   書き出す必要があるため、先に行を1回走査して幅だけを求め、もう1回走査して行を書き出す
 *   （「リンク」は DB を2回読むが、どちらもバッチ単位で読むのでメモリは増えない）。
 * - 縦結合（サイトマップ階層）は commit 済みの行には適用できないため、結合のあるシートだけは
 *   全行（＝ページ数分）を追加してから結合し、最後にまとめて commit する。
 * - 行数が Excel の上限を超えるシートは、上限の1行手前で打ち切り、最終行に省略した旨を書く
 *   （上限を超える行を書くと Excel で開けないファイルになるため）。
 * - isAborted() が true になったら（クライアント切断）ExportAbortedError で中断する。
 *   書きかけのファイルの削除は呼び出し側が行う。
 */
export async function writeXlsxFile(datasets: Dataset[], filename: string, isAborted: () => boolean): Promise<void> {
  // 共有文字列は従来（メモリ上の Workbook）と同じく使う。表に載るのはユニークな文字列だけで、
  // 大半を占める「リンク」の値は URL（ページ数ぶん）と種別名の繰り返しなので、表はページ数規模に収まる。
  // 使わない（インライン文字列）とファイルサイズが約1.6倍になる。
  // 書き出し先のファイルストリームは自前で開き、中断・失敗時に確実に閉じられるようにする
  // （WorkbookWriter には中断の API が無く、開いたままにすると Linux では削除後もファイルの領域と
  //  ファイルディスクリプタが解放されず、Windows では削除自体が保留される）
  const out = createWriteStream(filename);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: true });
  try {
    await writeSheets(wb, datasets, isAborted);
    await wb.commit(); // zip を確定し、ファイルへの書き出し完了（finish）まで待つ
  } catch (err) {
    try {
      (wb as unknown as { zip?: { abort?: () => void } }).zip?.abort?.();
    } catch {
      // 中断処理自体の失敗は無視する（元の例外を優先して伝える）
    }
    if (!out.closed) {
      await new Promise<void>((resolve) => {
        out.once("close", () => resolve());
        out.destroy();
      });
    }
    throw err;
  }
}

async function writeSheets(
  wb: InstanceType<typeof ExcelJS.stream.xlsx.WorkbookWriter>,
  datasets: Dataset[],
  isAborted: () => boolean
): Promise<void> {
  const checkAbort = () => {
    if (isAborted()) throw new ExportAbortedError();
  };
  for (const ds of datasets) {
    const headers = ds.excel?.headers ?? ds.headers;
    const excelRows = ds.excel?.rows;
    const rowsOf = (): AsyncIterable<Row[]> =>
      excelRows
        ? (async function* () {
            yield excelRows;
          })()
        : ds.rows();

    // 1回目の走査: 列幅と行数
    const maxLen = headers.map((h) => h.length);
    let total = 0;
    for await (const batch of rowsOf()) {
      checkAbort();
      for (const r of batch) {
        for (let i = 0; i < headers.length; i++) {
          const len = String(r[i] ?? "").length;
          if (len > maxLen[i]) maxLen[i] = len;
        }
      }
      total += batch.length;
    }
    const capacity = XLSX_MAX_ROWS - 1; // ヘッダー行を除いた書ける行数
    const overflow = total > capacity;
    const writable = overflow ? capacity - 1 : total; // 上限超過時は最終行を注記に使う

    const ws = wb.addWorksheet(ds.sheet, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = maxLen.map((len) => ({ width: Math.min(48, Math.max(10, len + 2)) }));
    const merges = ds.excel?.merges ?? [];
    const commitEachRow = merges.length === 0;

    const header = ws.addRow(headers);
    header.font = { bold: true };
    if (commitEachRow) header.commit();

    // 2回目の走査: 行の書き出し
    let written = 0;
    outer: for await (const batch of rowsOf()) {
      checkAbort();
      for (const r of batch) {
        if (written >= writable) break outer;
        const row = ws.addRow(neutralizeRow(r));
        if (commitEachRow) row.commit();
        written++;
      }
      // 行の commit はシートの書き出しストリームへ同期的に積まれるため、バッチごとに
      // イベントループへ制御を返し、ファイルへの書き出しや他のリクエストの処理を進める
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (overflow) {
      const note = ws.addRow([`（Excel の行数上限のため、以降の ${total - writable} 行は省略しました。全件は CSV で出力してください）`]);
      if (commitEachRow) note.commit();
      console.warn(`[export] シート「${ds.sheet}」が Excel の行数上限を超えたため ${total - writable} 行を省略しました`);
    }

    // 階層列の縦結合（ツリーの親ノードを子孫の行範囲にまたがって表示）
    for (const m of merges) {
      const rowStart = m.rowStart + 2; // ヘッダー行(1) + 0始まり→1始まり
      const rowEnd = m.rowEnd + 2;
      const col = m.col + 1;
      ws.mergeCells(rowStart, col, rowEnd, col);
      ws.getCell(rowStart, col).alignment = { vertical: "top", wrapText: true };
    }
    ws.commit();
  }
}
