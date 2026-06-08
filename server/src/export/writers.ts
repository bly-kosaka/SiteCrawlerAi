import ExcelJS from "exceljs";
import type { Dataset } from "./datasets.js";

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

export function toCsv(ds: Dataset): string {
  const lines = [ds.headers.map(csvEscape).join(",")];
  for (const row of ds.rows) lines.push(row.map(csvEscape).join(","));
  return "﻿" + lines.join("\r\n");
}

// Excel/CSV共通: 文字列セルのみ無害化する（数値・真偽値はそのまま）
function neutralizeRow(row: (string | number)[]): (string | number)[] {
  return row.map((v) => (typeof v === "string" ? neutralizeFormula(v) : v));
}

export async function toXlsxBuffer(datasets: Dataset[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const ds of datasets) {
    const ws = wb.addWorksheet(ds.sheet, { views: [{ state: "frozen", ySplit: 1 }] });
    const headers = ds.excel?.headers ?? ds.headers;
    const rows = ds.excel?.rows ?? ds.rows;
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    for (const row of rows) ws.addRow(neutralizeRow(row));
    ws.columns = headers.map((h, i) => {
      const maxLen = rows.reduce((m, r) => Math.max(m, String(r[i] ?? "").length), h.length);
      return { width: Math.min(48, Math.max(10, maxLen + 2)) };
    });
    // 階層列の縦結合（ツリーの親ノードを子孫の行範囲にまたがって表示）
    for (const m of ds.excel?.merges ?? []) {
      const rowStart = m.rowStart + 2; // ヘッダー行(1) + 0始まり→1始まり
      const rowEnd = m.rowEnd + 2;
      const col = m.col + 1;
      ws.mergeCells(rowStart, col, rowEnd, col);
      ws.getCell(rowStart, col).alignment = { vertical: "top", wrapText: true };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
