// common.jsx の STATUS_META / ISSUE_META を移植（フロント表示ラベルと厳密一致させる）

export type Issue = "broken" | "redirect" | "orphan" | "dup-title" | "dup-h1" | "noindex" | "slow";

export const ISSUE_LABEL_JP: Record<Issue, string> = {
  broken: "リンク切れ",
  redirect: "リダイレクト",
  orphan: "孤立ページ",
  "dup-title": "タイトル重複",
  "dup-h1": "H1重複",
  noindex: "Noindex",
  slow: "低速TTFB",
};

export const STATUS_JP: Record<number, string> = {
  200: "正常",
  301: "恒久リダイレクト",
  302: "一時リダイレクト",
  404: "未検出",
  410: "削除済",
  500: "サーバーエラー",
};

export const EDGE_TYPE_JP: Record<string, string> = {
  tree: "構造",
  nav: "ナビ",
  footer: "フッター",
  context: "本文",
  redirect: "リダイレクト",
};

export const SLOW_TTFB_MS = 600;
