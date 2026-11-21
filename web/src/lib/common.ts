/* ============================================================
   共通ヘルパー — ステータス/問題の定義（全画面で共有）
   ported from common.jsx (window globals → module exports)
   ============================================================ */
import type { PageNode, PageTreeNode, StopReason } from "./types";

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

// flat + parent から木構造を構築する（「リンク構造」ツリー = site.tree）。
// 以前はサーバーの /tree が組み立てた入れ子JSONを受け取っていたが、/pages と全ページを
// 二重に転送・DB読み出ししていたため、取得済みの flat から組み立てるようにした。
// ロジックは server/src/serialize.ts の buildTree と同一（エクスポートのツリーと一致させるため、
// 変更する場合は両方を合わせること）。flat は /pages の既定順（URL 昇順）である前提。
// メモリ節約のため、ツリーのノードは複製せず flat の各ページオブジェクトそのものに children を付ける
// （flat と tree で同じオブジェクトを共有する。以前は全ページを複製して二重に保持していた）。
// そのため引数の各要素を書き換える。呼び出し元は API から取得した直後の配列を渡すこと。
export function buildTree(pages: PageNode[]): PageTreeNode | null {
  const byId = new Map<string, PageTreeNode>();
  for (const p of pages) {
    const node = p as PageTreeNode;
    node.children = [];
    byId.set(p.id, node);
  }
  let root: PageTreeNode | null = null;
  for (const p of pages) {
    const node = byId.get(p.id)!;
    if (p.parent && byId.has(p.parent)) {
      byId.get(p.parent)!.children!.push(node);
    } else if (p.depth === 0) {
      root = node;
    }
  }
  if (!root) root = byId.values().next().value ?? null;
  return root;
}

// URLパスのディレクトリ構造に基づいてツリーを構築する。
// 通常のツリー（site.tree）はクロール中に最初にリンクを発見した経路を親とするため、
// HTMLサイトマップのような「全ページへのリンク集」が他ページの親になってしまうことがある。
// その代替として、URLパスの上位セグメントに該当する既存ページを親とみなすツリーを提供する。
export function buildPathTree(flat: PageNode[]): PageTreeNode | null {
  if (!flat.length) return null;
  const byUrl = new Map(flat.map((n) => [n.url, n]));
  const root = byUrl.get("/") ?? flat.reduce((a, b) => (a.depth <= b.depth ? a : b));

  const childrenOf = new Map<string, PageNode[]>();
  for (const n of flat) {
    if (n.url === root.url) continue;
    const segs = n.url.split("/").filter(Boolean);
    let parent = root;
    for (let i = segs.length - 1; i > 0; i--) {
      const candidate = byUrl.get("/" + segs.slice(0, i).join("/"));
      if (candidate) { parent = candidate; break; }
    }
    if (!childrenOf.has(parent.url)) childrenOf.set(parent.url, []);
    childrenOf.get(parent.url)!.push(n);
  }

  const build = (n: PageNode, depth: number): PageTreeNode => ({
    ...n,
    depth,
    children: (childrenOf.get(n.url) || [])
      .sort((a, b) => a.url.localeCompare(b.url))
      .map((k) => build(k, depth + 1)),
  });
  return build(root, 0);
}

// 打ち切られたクロールの通知文言。理由(stopReason)は進捗 SSE の done イベントでしか分からず
// DB には残らないため、このタブで完了を見届けていない場合（リロード後・他タブで実行など）は
// undefined/null となり、汎用文言にする。cancel はユーザー自身の操作なので警告色ではなく情報表示。
export function truncationNotice(stopReason: StopReason | null | undefined, pages: number): { cls: "warn" | "info"; text: string } {
  const got = `${pages.toLocaleString()} 件取得済`;
  switch (stopReason) {
    case "pages":
      return { cls: "warn", text: `ページ数の上限に達したため、クロールを途中で打ち切りました（${got}）。サイト全体を網羅していない可能性があります。` };
    case "heap":
      return { cls: "warn", text: `サーバーのメモリを保護するため、クロールを途中で打ち切りました（${got}）。サイト全体を網羅していない可能性があります。再クロールすると改善することがあります。` };
    case "time":
      return { cls: "warn", text: `60分の時間上限に達したため、クロールを途中で打ち切りました（${got}）。サイト全体を網羅していない可能性があります。` };
    case "cancel":
      return { cls: "info", text: `ユーザーの操作でクロールを中止しました。中止までに取得した結果（${got}）を表示しています。` };
    default:
      return { cls: "warn", text: `このクロールは途中で打ち切られたため、結果は一部です（${got}）。再クロールすると改善することがあります。` };
  }
}

export const orphanReason =(n: PageNode) => {
  const r = ["内部リンクなし"];
  if (n.noindex) r.push("noindex");
  if (n.status === 404 || n.status === 410) r.push("削除済");
  return r.join(" ・ ");
};
