/* API client — replaces data.js / window.SITE with fetches against the Fastify backend */
import type { CrawlSummary, PageNode, PageDetail, PageTreeNode, Edge, AnalysisSummary, RedirectChain, SiteData } from "./types";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3001";

// API認証はサーバー側が発行する署名付き httpOnly Cookie で行う(ログイン画面でAPIキーを
// 一度入力すると、以後はブラウザが自動的にCookieを送信する)。
// 旧方式(APIキーをビルド時に VITE_API_KEY としてバンドルへ埋め込み、x-api-keyヘッダーや
// SSE用の ?key= クエリへ平文で載せる)は、ビルド成果物を取得すれば誰でもAPIキーを
// 読み取れてしまい、また ?key= がアクセスログに平文で残り続けるため廃止した。
// fetch には毎回 credentials:"include" を付与し、Cookieを確実に送受信する。

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function login(apiKey: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/api/logout`, { method: "POST", credentials: "include" });
}

export async function checkSession(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/me`, { credentials: "include" });
  return res.ok;
}

export const api = {
  listCrawls: () => get<CrawlSummary[]>("/api/crawls"),
  getCrawl: (id: string) => get<CrawlSummary>(`/api/crawls/${id}`),
  startCrawl: (body: { startUrl: string; maxDepth?: number; label?: string; render?: boolean }) =>
    request("/api/crawls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ id: string; status: string }>),
  recrawl: (id: string) =>
    request(`/api/crawls/${id}/recrawl`, { method: "POST" }).then((r) => r.json() as Promise<{ id: string; status: string }>),
  setActive: (id: string) =>
    request(`/api/crawls/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    }).then((r) => r.json() as Promise<CrawlSummary>),
  deleteCrawl: (id: string) =>
    request(`/api/crawls/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`delete ${id}: HTTP ${r.status}`);
    }),

  pages: (id: string) => get<PageNode[]>(`/api/crawls/${id}/pages`),
  page: (id: string, pageId: string) => get<PageDetail>(`/api/crawls/${id}/pages/${pageId}`),
  tree: (id: string) => get<PageTreeNode | null>(`/api/crawls/${id}/tree`),
  links: (id: string) => get<{ nodes: PageNode[]; edges: Edge[] }>(`/api/crawls/${id}/links`),
  summary: (id: string) => get<AnalysisSummary>(`/api/crawls/${id}/summary`),
  errors: (id: string) => get<PageNode[]>(`/api/crawls/${id}/issues/errors`),
  redirects: (id: string) => get<RedirectChain[]>(`/api/crawls/${id}/issues/redirects`),
  orphans: (id: string) => get<(PageNode & { reason: string })[]>(`/api/crawls/${id}/issues/orphans`),

  // SSE/エクスポートのDLリンクはCookie認証(withCredentials/ブラウザの自動送信)に乗るため、
  // 認証情報をURLへ載せる必要が無い
  progressUrl: (id: string) => `${BASE}/api/crawls/${id}/progress`,
  exportXlsxUrl: (id: string, datasets?: string[]) =>
    `${BASE}/api/crawls/${id}/export.xlsx${datasets?.length ? `?datasets=${datasets.join(",")}` : ""}`,
  exportCsvUrl: (id: string, dataset: string) => `${BASE}/api/crawls/${id}/export/${dataset}.csv`,
};

/* ---- composite loader: builds a SiteData bundle for the active crawl ---- */
export async function loadSite(crawlId: string): Promise<SiteData> {
  const [crawl, flat, tree, linkGraph, summary] = await Promise.all([
    api.getCrawl(crawlId),
    api.pages(crawlId),
    api.tree(crawlId),
    api.links(crawlId),
    api.summary(crawlId),
  ]);
  return {
    crawl,
    tree,
    flat,
    edges: linkGraph.edges,
    summary,
    host: crawl.host,
    counts: {
      pages: summary.pages,
      ok: summary.ok,
      errors: summary.errors,
      redirects: summary.redirects,
      orphans: summary.orphans,
      noindex: summary.noindex,
      dupTitles: summary.dupTitles,
    },
  };
}

export function subscribeProgress(
  crawlId: string,
  onEvent: (type: string, data: unknown) => void
): () => void {
  const es = new EventSource(api.progressUrl(crawlId), { withCredentials: true });
  const types = ["progress", "status", "done", "error"];
  const handlers = types.map((t) => {
    const h = (e: MessageEvent) => {
      try {
        onEvent(t, JSON.parse(e.data));
      } catch {
        onEvent(t, e.data);
      }
    };
    es.addEventListener(t, h as EventListener);
    return [t, h] as const;
  });
  return () => {
    handlers.forEach(([t, h]) => es.removeEventListener(t, h as EventListener));
    es.close();
  };
}
