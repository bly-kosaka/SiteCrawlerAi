/* ============================================================
   共通ヘルパー — ステータス/問題の定義（全画面で共有）
   ported from common.jsx (window globals → module exports)
   ============================================================ */
import type { PageNode } from "./types";

export const STATUS_META: Record<number, { cls: string; dot: string; label: string; jp: string }> = {
  200: { cls: "ok", dot: "ok", label: "200", jp: "正常" },
  301: { cls: "info", dot: "info", label: "301", jp: "恒久リダイレクト" },
  302: { cls: "info", dot: "info", label: "302", jp: "一時リダイレクト" },
  404: { cls: "err", dot: "err", label: "404", jp: "未検出" },
  410: { cls: "err", dot: "err", label: "410", jp: "削除済" },
  500: { cls: "err", dot: "err", label: "500", jp: "サーバーエラー" },
};

export const ISSUE_META: Record<string, { cls: string; label: string; short: string }> = {
  broken:     { cls: "err",    label: "リンク切れ",   short: "切れ" },
  redirect:   { cls: "info",   label: "リダイレクト", short: "転送" },
  orphan:     { cls: "warn",   label: "孤立ページ",   short: "孤立" },
  "dup-title":{ cls: "warn",   label: "タイトル重複", short: "重複" },
  "dup-h1":   { cls: "warn",   label: "H1重複",       short: "H1重複" },
  noindex:    { cls: "violet", label: "Noindex",      short: "Noindex" },
  slow:       { cls: "warn",   label: "低速TTFB",     short: "低速" },
};

export const ISSUE_HINT: Record<string, string> = {
  broken: "エラーを返します。リンクを修正/削除",
  redirect: "内部リンクを最終URLに更新",
  orphan: "内部リンクが1つもありません",
  "dup-title": "他ページと title が重複",
  "dup-h1": "他ページと H1 が重複",
  noindex: "検索インデックスから除外",
  slow: "TTFBが600msを超過",
};

export const statusOf = (n: { status: number }) =>
  STATUS_META[n.status] || { cls: "muted", dot: "muted", label: String(n.status), jp: "" };

export const lastSeg = (u: string) => (u === "/" ? "/" : u.replace(/\/$/, "").split("/").pop() as string);

export const statusClass = (code: number) => (code === 200 ? "ok" : [301, 302].includes(code) ? "info" : "err");

// CSV / ダウンロード共通
export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function buildCSV(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((r) => lines.push(r.map(csvEscape).join(",")));
  return "﻿" + lines.join("\r\n");
}
export function downloadFile(name: string, content: string | Blob, mime = "text/csv;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

export const issuesText = (issues: string[]) => issues.map((i) => ISSUE_META[i]?.label ?? i).join(" / ");

export const orphanReason = (n: PageNode) => {
  const r = ["内部リンクなし"];
  if (n.noindex) r.push("noindex");
  if (n.status === 404 || n.status === 410) r.push("削除済");
  return r.join(" ・ ");
};
