/* API client — replaces data.js / window.SITE with fetches against the Fastify backend */
import type { CrawlSummary, PageNode, PageDetail, Edge, AnalysisSummary, RedirectChain, SiteData } from "./types";
import { buildTree } from "./common";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3001";

// API認証はサーバー側のHTTP Basic認証で行う。ブラウザがページ読み込み時に
// 一度ID/PASSWORDダイアログで取得した資格情報を、以後のリクエストへ自動付与する
// (Authorization ヘッダー、EventSourceも withCredentials:true で同様)ため、
// フロントエンド側で認証情報を意識する必要は無い。fetch には credentials:"include"
// を付与し、Cookie(クロール選択状態の保存用など)も確実に送受信する。

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { credentials: "include", ...init });
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  // 呼び出し側が 404 等を判別できるよう ApiError（Error のサブクラス）で投げる
  if (!res.ok) throw new ApiError(res.status, `${path}: HTTP ${res.status}`, null);
  return res.json() as Promise<T>;
}

// HTTP ステータスとサーバーの応答本文を保持するエラー。
// クロール開始・中止は 409（実行中/実行中でない）・429（レート制限）を
// 「失敗」と区別して表示する必要があるため、ステータスで判別できるようにする。
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const res = await request(path, init);
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 本文が JSON でない（または空）
  }
  if (!res.ok) {
    // error は文字列のほか、入力検証エラー(400)では zod の flatten 結果（オブジェクト）の場合がある
    const message = typeof body?.error === "string"
      ? body.error
      : res.status === 400 ? "入力内容が正しくありません。" : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  listCrawls: () => get<CrawlSummary[]>("/api/crawls"),
  getCrawl: (id: string) => get<CrawlSummary>(`/api/crawls/${id}`),
  startCrawl: (body: { startUrl: string; maxDepth?: number; label?: string; render?: boolean }) =>
    send<{ id: string; status: string }>("/api/crawls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  recrawl: (id: string) =>
    send<{ id: string; status: string }>(`/api/crawls/${id}/recrawl`, { method: "POST" }),
  // 202 { status: "cancelling" | "saving" }。完了は進捗 SSE の done で通知される
  cancelCrawl: (id: string) =>
    send<{ id: string; status: "cancelling" | "saving" }>(`/api/crawls/${id}/cancel`, { method: "POST" }),
  setActive: (id: string) =>
    request(`/api/crawls/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    }).then((r) => r.json() as Promise<CrawlSummary>),
  // 実行中のクロールは 409 { error, status } で拒否される（ApiError で投げる）
  deleteCrawl: (id: string) =>
    send<null>(`/api/crawls/${id}`, { method: "DELETE" }).then(() => undefined),

  pages: (id: string) => get<PageNode[]>(`/api/crawls/${id}/pages`),
  page: (id: string, pageId: string) => get<PageDetail>(`/api/crawls/${id}/pages/${pageId}`),
  // edges のみ（ノードは pages で取得済みの flat を使う）。リンク画面を開いたときに遅延取得する。
  links: (id: string) => get<{ edges: Edge[] }>(`/api/crawls/${id}/links`),
  linksCount: (id: string) => get<{ count: number }>(`/api/crawls/${id}/links/count`),
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
// 全ページを含む巨大レスポンスはサーバーのメモリ（Prisma エンジン）を大きく消費するため、
// 初期ロードでは pages を1回だけ取得し、ツリーはその flat からクライアント側で組み立てる。
// edges はリンク画面でのみ使うので遅延取得し（SiteContext の ensureEdges）、ここでは件数だけ取る。
export async function loadSite(crawlId: string): Promise<SiteData> {
  const [crawl, flat, edgeCount, summary] = await Promise.all([
    api.getCrawl(crawlId),
    api.pages(crawlId),
    api.linksCount(crawlId).then((r) => r.count),
    api.summary(crawlId),
  ]);
  return {
    crawl,
    tree: buildTree(flat),
    flat,
    edgeCount,
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

// 進捗 SSE の接続状態。
//   open        : 接続中（再接続に成功した場合も通知される）
//   reconnecting: 接続が切れ、再接続を待っている（プロキシのアイドル切断・一時的なネットワーク断など）
export type ProgressConnection = "open" | "reconnecting";

// EventSource が再接続を諦めた（readyState=CLOSED。HTTP エラー応答など）ときに自前で張り直す間隔
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

// 進捗 SSE を購読する。
// 注意: EventSource の "error" イベントは2種類ある。
//   - サーバーが送る `event: error`（クロール失敗。MessageEvent で data あり）→ onEvent("error", data)
//   - 接続エラー（data なしの Event）→ クロール失敗ではない。EventSource の自動再接続に任せ、
//     onConnection("reconnecting") で通知するだけにする（以前はこれをクロール失敗として扱い、
//     購読を止めてしまっていたため、一時的な切断で進捗表示が消え、完了しても再読込されなかった）。
export function subscribeProgress(
  crawlId: string,
  onEvent: (type: string, data: unknown) => void,
  onConnection?: (state: ProgressConnection) => void
): () => void {
  let es: EventSource | null = null;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RECONNECT_MIN_MS;

  const dispatch = (t: string) => (e: Event) => {
    const data = (e as MessageEvent).data;
    if (t === "error" && (typeof data !== "string" || data === "")) return; // 接続エラーは onerror 側で扱う
    try {
      onEvent(t, JSON.parse(data));
    } catch {
      onEvent(t, data);
    }
  };

  const connect = () => {
    if (disposed) return;
    const src = new EventSource(api.progressUrl(crawlId), { withCredentials: true });
    es = src;
    for (const t of ["progress", "status", "done", "error"]) src.addEventListener(t, dispatch(t));
    src.onopen = () => {
      retryMs = RECONNECT_MIN_MS;
      onConnection?.("open");
    };
    src.onerror = (e) => {
      if (disposed) return;
      const data = (e as MessageEvent).data;
      if (typeof data === "string" && data !== "") return; // サーバー発の error イベント（dispatch 側で処理済み）
      onConnection?.("reconnecting");
      if (src.readyState === EventSource.CLOSED) {
        // ブラウザが再接続を諦めた場合は、間隔を空けて自前で張り直す
        src.close();
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
      }
      // CONNECTING の場合はブラウザが自動で再接続する
    };
  };
  connect();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}
