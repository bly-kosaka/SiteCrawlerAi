/* Site/crawl state — replaces window.SITE global with live API-backed context */
import React from "react";
import { api, ApiError, loadSite, subscribeProgress } from "./api";
import type { CrawlSummary, CrawlProgress, SiteData, Edge, StopReason, CrawlDoneEvent } from "./types";

// 実行中クロールの進捗表示用の状態。
// cancel: 中止ボタンの状態。"requesting" は中止 API の応答待ち（二重押し防止）、
// "cancelling"/"saving" はサーバーが受け付けた後（完了は SSE の done を待つ）。
// conn: 進捗 SSE の接続状態。"reconnecting" の間は進捗表示に「再接続中…」を出す。
export interface CrawlRunState extends CrawlProgress {
  id: string;
  url: string;
  cancel: "none" | "requesting" | "cancelling" | "saving";
  conn: "ok" | "reconnecting";
}

// 進捗 SSE が切れている間だけ、完了の見落としに備えてクロールの状態を確認する間隔。
// （常時ポーリングはしない。SSE が再接続すればサーバーが現在の状態を送るため、これは保険）
const POLL_WHILE_DISCONNECTED_MS = 45_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// クロール開始・再クロール・中止の結果をユーザーへ伝える通知。
//   busy : 別のクロールが実行中（409）。runningId があれば、そのクロールの進捗表示へ切り替えられる
//   rate : レート制限（429）
//   error: それ以外の失敗
export interface CrawlNotice {
  kind: "busy" | "rate" | "error";
  text: string;
  runningId?: string;
}

const RATE_LIMIT_TEXT = "操作が短時間に集中したため受け付けられませんでした。少し待ってから再実行してください。";

// リンク画面用 edges の遅延取得状態。crawlId 単位で保持し、表示中のクロールデータ(site)が
// 差し替わったとき（クロール切替・クロール完了後の再読込・削除）に破棄する。
export interface EdgesState {
  crawlId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  edges: Edge[];
  error: string | null;
}
const EDGES_IDLE: EdgesState = { crawlId: null, status: "idle", edges: [], error: null };

interface SiteCtx {
  crawls: CrawlSummary[];
  activeId: string | null;
  site: SiteData | null;
  loading: boolean;
  crawlRun: CrawlRunState | null;
  notice: CrawlNotice | null;
  // このタブで完了を見届けたクロールの打ち切り理由（crawlId → 理由）。リロードすると失われる
  stopReasons: Record<string, StopReason | null>;
  linkEdges: EdgesState;
  // 指定クロールの edges を未取得なら取得する（取得中・取得済みなら何もしない）
  ensureEdges: (crawlId: string) => void;
  setActiveId: (id: string) => void;
  startCrawl: (startUrl: string, maxDepth: number) => Promise<void>;
  recrawl: (id: string) => Promise<void>;
  cancelCrawl: () => Promise<void>;
  // 409 で通知された実行中クロールを表示対象にして進捗を購読する
  followRunning: (id: string) => Promise<void>;
  dismissNotice: () => void;
  deleteCrawl: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<SiteCtx | null>(null);

const isInProgress = (status: string) => status === "running" || status === "queued";

export function SiteProvider({ children }: { children: React.ReactNode }) {
  const [crawls, setCrawls] = React.useState<CrawlSummary[]>([]);
  const [activeId, setActiveIdStateRaw] = React.useState<string | null>(null);
  // SSE のコールバックは購読開始時のクロージャで動き続けるため、state の activeId を直接参照すると
  // 購読開始時点の古い値（初回ロード時は null、新規クロール開始時は直前のクロール）になり、
  // 完了("done")受信後の再読込が行われなかった。最新値を ref でも保持してそちらを参照する。
  const activeIdRef = React.useRef<string | null>(null);
  const setActiveIdState = React.useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdStateRaw(id);
  }, []);
  const [site, setSite] = React.useState<SiteData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [crawlRun, setCrawlRun] = React.useState<CrawlRunState | null>(null);
  // 進捗を購読中のクロールID（SSE の購読と対応）
  const runIdRef = React.useRef<string | null>(null);
  // SSE 切断中だけ動かす状態確認のタイマー
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // 最新のクロール一覧（コールバック内から参照する用）
  const crawlsRef = React.useRef<CrawlSummary[]>([]);
  // 中止を送信済みのクロールID（二重送信防止）
  const cancelSentRef = React.useRef<string | null>(null);
  const [notice, setNotice] = React.useState<CrawlNotice | null>(null);
  const [stopReasons, setStopReasons] = React.useState<Record<string, StopReason | null>>({});
  const unsubRef = React.useRef<(() => void) | null>(null);
  // loadActive の世代番号。切替や完了直後の再読込で複数の読み込みが重なったとき、
  // 後から開始した読み込みの結果だけを反映する（古い結果で上書きしない）
  const loadGenRef = React.useRef(0);
  const [linkEdges, setLinkEdges] = React.useState<EdgesState>(EDGES_IDLE);
  // 取得要求済み（取得中 or 取得済み）のクロールID。二重リクエスト防止用
  const edgesRequestedRef = React.useRef<string | null>(null);
  // 破棄のたびに進める世代番号。破棄前に発行したリクエストの結果を無視するために使う
  const edgesGenRef = React.useRef(0);

  const resetEdges = React.useCallback(() => {
    edgesGenRef.current++;
    edgesRequestedRef.current = null;
    setLinkEdges(EDGES_IDLE);
  }, []);

  const ensureEdges = React.useCallback((crawlId: string) => {
    if (edgesRequestedRef.current === crawlId) return;
    edgesRequestedRef.current = crawlId;
    const gen = ++edgesGenRef.current;
    setLinkEdges({ crawlId, status: "loading", edges: [], error: null });
    api.links(crawlId).then(
      ({ edges }) => {
        if (gen !== edgesGenRef.current) return;
        setLinkEdges({ crawlId, status: "ready", edges, error: null });
      },
      (err: unknown) => {
        if (gen !== edgesGenRef.current) return;
        edgesRequestedRef.current = null; // 再試行できるようにする
        setLinkEdges({ crawlId, status: "error", edges: [], error: err instanceof Error ? err.message : String(err) });
      }
    );
  }, []);

  const refreshList = React.useCallback(async () => {
    const list = await api.listCrawls();
    crawlsRef.current = list;
    setCrawls(list);
    return list;
  }, []);

  const loadActive = React.useCallback(async (id: string) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    try {
      const data = await loadSite(id);
      if (gen !== loadGenRef.current) return;
      // site の差し替えと同時に edges を破棄する（同じクロールの再読込でも、
      // クロール完了直後などで内容が変わり得るため取り直す）
      resetEdges();
      setSite(data);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [resetEdges]);

  // loadActive / refreshList の失敗を通知に変える（呼び出し元で await しない箇所で
  // 未処理の Promise 拒否にしない。失敗しても直前の表示は残る）
  const loadActiveSafe = React.useCallback(async (id: string) => {
    try {
      await loadActive(id);
    } catch (err) {
      setNotice({ kind: "error", text: `クロール結果を読み込めませんでした（${errText(err)}）。時間をおいてページを再読み込みしてください。` });
    }
  }, [loadActive]);
  const refreshListSafe = React.useCallback(async (): Promise<CrawlSummary[] | null> => {
    try {
      return await refreshList();
    } catch (err) {
      setNotice({ kind: "error", text: `クロール一覧を読み込めませんでした（${errText(err)}）。時間をおいてページを再読み込みしてください。` });
      return null;
    }
  }, [refreshList]);

  const clearPoll = React.useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const stopWatching = React.useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    runIdRef.current = null;
    clearPoll();
    setCrawlRun(null);
  }, [clearPoll]);

  // クロールの終了（SSE の done/status/error、または切断中の状態確認で終了を検知）を処理する。
  // done の data は、実行中に購読していれば {id, truncated, stopReason}、完了後に購読（再接続）した
  // 場合は {id, status} の形で届く。後者は打ち切り理由が分からないので記録しない（汎用文言になる）。
  const finishRun = React.useCallback((id: string, type: string, data: unknown) => {
    if (runIdRef.current !== id) return; // 既に処理済み（SSE と状態確認の両方から届いた場合など）
    if (type === "done" && data && typeof data === "object" && "truncated" in data) {
      // 打ち切り理由は done イベントでしか分からないため、このタブで保持しておく
      const d = data as CrawlDoneEvent;
      setStopReasons((s) => ({ ...s, [id]: d.truncated ? d.stopReason ?? null : null }));
    }
    if (type === "error") {
      // サーバー発の `event: error`（クロール自体の失敗）
      const message = data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : "";
      setNotice({ kind: "error", text: `クロールがエラーで終了しました${message ? `（${message}）` : ""}。` });
    }
    stopWatching();
    void refreshListSafe();
    // 実行中は analysis 系 API が空の結果を返す（保存途中の行を読まないためのサーバー側ガード）ので、
    // 完了後にここで表示中クロールを読み直して結果を出す
    if (id === activeIdRef.current) void loadActiveSafe(id);
  }, [loadActiveSafe, refreshListSafe, stopWatching]);

  const watchProgress = React.useCallback((id: string, startUrl: string) => {
    unsubRef.current?.();
    clearPoll();
    runIdRef.current = id;
    setCrawlRun({ pct: 0, found: 0, total: 0, queue: 0, speed: 0, cur: "", id, url: startUrl, cancel: "none", conn: "ok" });

    // SSE が切れている間だけ、完了の見落としに備えて状態を確認する
    const checkStatus = async () => {
      if (runIdRef.current !== id) return;
      try {
        const c = await api.getCrawl(id);
        if (!isInProgress(c.status)) finishRun(id, c.status === "done" ? "done" : "status", { id, status: c.status });
      } catch (err) {
        // 削除されていた場合は終了扱い。それ以外（通信断など）は次回に持ち越す
        if (err instanceof ApiError && err.status === 404) finishRun(id, "status", { id, status: "deleted" });
      }
    };

    unsubRef.current = subscribeProgress(
      id,
      (type, data) => {
        if (type === "progress") {
          const d = data as CrawlProgress;
          // 中止要求中の表示状態は進捗更新で消さない
          setCrawlRun((prev) => ({ ...d, id, url: startUrl, cancel: prev?.id === id ? prev.cancel : "none", conn: "ok" }));
        } else if (type === "done" || type === "error" || type === "status") {
          finishRun(id, type, data);
        }
      },
      (state) => {
        if (runIdRef.current !== id) return;
        setCrawlRun((prev) => (prev && prev.id === id ? { ...prev, conn: state === "open" ? "ok" : "reconnecting" } : prev));
        if (state === "open") {
          clearPoll();
        } else if (!pollTimerRef.current) {
          pollTimerRef.current = setInterval(() => { void checkStatus(); }, POLL_WHILE_DISCONNECTED_MS);
        }
      }
    );
  }, [clearPoll, finishRun]);

  // initial load
  React.useEffect(() => {
    (async () => {
      const list = await refreshListSafe();
      if (!list) { setLoading(false); return; }
      const active = list.find((c) => c.active) ?? list[0];
      if (active) {
        setActiveIdState(active.id);
        await loadActiveSafe(active.id);
      } else {
        setLoading(false);
      }
      // 実行中のクロールがあれば、表示対象かどうかに関係なく進捗を購読する
      // （リロード時や、他のタブ・他の利用者が開始したクロールでも進捗と中止ボタンを出すため）。
      // 同時に実行できるクロールはサーバー側で1件に制限されている。
      const inProgress = list.find((c) => isInProgress(c.status));
      if (inProgress) watchProgress(inProgress.id, inProgress.startUrl);
    })();
    return () => { unsubRef.current?.(); if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setActiveId = React.useCallback((id: string) => {
    setActiveIdState(id);
    void loadActiveSafe(id);
    api.setActive(id).then(() => refreshListSafe(), () => refreshListSafe());
  }, [loadActiveSafe, refreshListSafe, setActiveIdState]);

  // 開始・再クロールの失敗を通知へ変換する（409/429 は「失敗」と区別する）
  const noticeForStartError = React.useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      const runningId = typeof err.body?.runningId === "string" ? err.body.runningId : undefined;
      setNotice({ kind: "busy", text: err.message, runningId });
    } else if (err instanceof ApiError && err.status === 429) {
      setNotice({ kind: "rate", text: RATE_LIMIT_TEXT });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `クロールを開始できませんでした（${msg}）` });
    }
  }, []);

  // 開始したクロールを表示対象にして進捗を購読する。
  // 直前のクロールの結果を表示したままにしないよう、新しいクロールを読み込む
  // （実行中は空の結果になり、各画面は「クロール中」のプレースホルダを出す。完了後に再読込される）。
  const beginWatching = React.useCallback(async (id: string, startUrl: string) => {
    setActiveIdState(id);
    watchProgress(id, startUrl);
    await Promise.all([refreshListSafe(), loadActiveSafe(id)]);
  }, [loadActiveSafe, refreshListSafe, setActiveIdState, watchProgress]);

  const startCrawl = React.useCallback(async (startUrl: string, maxDepth: number) => {
    setNotice(null);
    let id: string;
    try {
      ({ id } = await api.startCrawl({ startUrl, maxDepth, render: false }));
    } catch (err) {
      noticeForStartError(err);
      return;
    }
    await beginWatching(id, startUrl);
  }, [beginWatching, noticeForStartError]);

  const recrawl = React.useCallback(async (id: string) => {
    setNotice(null);
    let newId: string;
    try {
      ({ id: newId } = await api.recrawl(id));
    } catch (err) {
      noticeForStartError(err);
      return;
    }
    // startUrl は進捗表示用。取得できなくても開始自体は成功しているので、元クロールの値で代用して購読を続ける
    let startUrl = crawlsRef.current.find((c) => c.id === id)?.startUrl ?? "";
    try {
      startUrl = (await api.getCrawl(newId)).startUrl;
    } catch {
      // 代用値のまま続行
    }
    await beginWatching(newId, startUrl);
  }, [beginWatching, noticeForStartError]);

  // 409 で通知された実行中クロールへ切り替える。
  // その間にクロールが終わって削除されていた等で見つからない場合は、通知して一覧を読み直す。
  const followRunning = React.useCallback(async (id: string) => {
    setNotice(null);
    let c: CrawlSummary;
    try {
      c = await api.getCrawl(id);
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof ApiError && err.status === 404
          ? "実行中のクロールが見つかりませんでした（既に削除された可能性があります）。一覧を更新しました。"
          : `実行中のクロールの情報を取得できませんでした（${errText(err)}）。一覧を更新しました。`,
      });
      await refreshListSafe();
      return;
    }
    setActiveId(id);
    if (isInProgress(c.status) && runIdRef.current !== id) watchProgress(id, c.startUrl);
  }, [refreshListSafe, setActiveId, watchProgress]);

  const cancelCrawl = React.useCallback(async () => {
    const id = runIdRef.current;
    // 二重押し防止（ボタンの無効化が描画に反映される前の連打も ref で弾く）
    if (!id || cancelSentRef.current === id) return;
    cancelSentRef.current = id;
    setCrawlRun((r) => (r && r.id === id ? { ...r, cancel: "requesting" } : r));
    try {
      const res = await api.cancelCrawl(id);
      setCrawlRun((r) => (r && r.id === id ? { ...r, cancel: res.status } : r));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // 既に終わっていた（または削除されていた）: 通知は出さず、最新状態を読み直す
        if (runIdRef.current === id) stopWatching();
        await refreshListSafe();
        if (activeIdRef.current) await loadActiveSafe(activeIdRef.current);
        return;
      }
      // 中止できなかったので、もう一度押せるように戻す
      cancelSentRef.current = null;
      setCrawlRun((r) => (r && r.id === id ? { ...r, cancel: "none" } : r));
      if (err instanceof ApiError && err.status === 429) setNotice({ kind: "rate", text: RATE_LIMIT_TEXT });
      else setNotice({ kind: "error", text: `クロールを中止できませんでした（${errText(err)}）` });
    }
  }, [loadActiveSafe, refreshListSafe, stopWatching]);

  const dismissNotice = React.useCallback(() => setNotice(null), []);

  const deleteCrawl = React.useCallback(async (id: string) => {
    try {
      await api.deleteCrawl(id);
    } catch (err) {
      // 実行中のクロールは 409 で拒否される（画面では削除ボタンを無効化しているが、他タブで開始された等で
      // 一覧が古い場合に起こり得る）。サーバーの文言を出して一覧を最新にする。進捗購読には触れない。
      if (err instanceof ApiError && err.status === 409) setNotice({ kind: "busy", text: err.message });
      else if (err instanceof ApiError && err.status === 429) setNotice({ kind: "rate", text: RATE_LIMIT_TEXT });
      else setNotice({ kind: "error", text: `クロール結果を削除できませんでした（${errText(err)}）` });
      await refreshListSafe();
      return;
    }
    const list = (await refreshListSafe()) ?? [];
    // 進捗購読は削除したクロールのものだけ止める（表示中のクロールとは別のクロールが実行中のことがある）
    if (runIdRef.current === id) stopWatching();
    if (id === activeId) {
      const next = list.find((c) => c.active) ?? list[0] ?? null;
      if (next) {
        setActiveIdState(next.id);
        await loadActiveSafe(next.id);
      } else {
        setActiveIdState(null);
        resetEdges();
        setSite(null);
      }
    }
  }, [activeId, loadActiveSafe, refreshListSafe, resetEdges, setActiveIdState, stopWatching]);

  const refresh = React.useCallback(async () => {
    await refreshListSafe();
    if (activeId) await loadActiveSafe(activeId);
  }, [activeId, loadActiveSafe, refreshListSafe]);

  const value = React.useMemo<SiteCtx>(() => ({
    crawls, activeId, site, loading, crawlRun, notice, stopReasons, linkEdges, ensureEdges,
    setActiveId, startCrawl, recrawl, cancelCrawl, followRunning, dismissNotice, deleteCrawl, refresh,
  }), [crawls, activeId, site, loading, crawlRun, notice, stopReasons, linkEdges, ensureEdges,
    setActiveId, startCrawl, recrawl, cancelCrawl, followRunning, dismissNotice, deleteCrawl, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSite(): SiteCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useSite must be used within SiteProvider");
  return ctx;
}
