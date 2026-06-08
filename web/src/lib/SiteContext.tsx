/* Site/crawl state — replaces window.SITE global with live API-backed context */
import React from "react";
import { api, loadSite, subscribeProgress } from "./api";
import type { CrawlSummary, CrawlProgress, SiteData } from "./types";

interface CrawlRunState extends CrawlProgress {
  url: string;
}

interface SiteCtx {
  crawls: CrawlSummary[];
  activeId: string | null;
  site: SiteData | null;
  loading: boolean;
  crawlRun: CrawlRunState | null;
  setActiveId: (id: string) => void;
  startCrawl: (startUrl: string, maxDepth: number) => Promise<void>;
  recrawl: (id: string) => Promise<void>;
  deleteCrawl: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<SiteCtx | null>(null);

export function SiteProvider({ children }: { children: React.ReactNode }) {
  const [crawls, setCrawls] = React.useState<CrawlSummary[]>([]);
  const [activeId, setActiveIdState] = React.useState<string | null>(null);
  const [site, setSite] = React.useState<SiteData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [crawlRun, setCrawlRun] = React.useState<CrawlRunState | null>(null);
  const unsubRef = React.useRef<(() => void) | null>(null);

  const refreshList = React.useCallback(async () => {
    const list = await api.listCrawls();
    setCrawls(list);
    return list;
  }, []);

  const loadActive = React.useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await loadSite(id);
      setSite(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const watchProgress = React.useCallback((id: string, startUrl: string) => {
    unsubRef.current?.();
    setCrawlRun({ pct: 0, found: 0, total: 0, queue: 0, speed: 0, cur: "", url: startUrl });
    unsubRef.current = subscribeProgress(id, (type, data) => {
      if (type === "progress") {
        const d = data as CrawlProgress;
        setCrawlRun({ ...d, url: startUrl });
      } else if (type === "done" || type === "error" || type === "status") {
        unsubRef.current?.();
        unsubRef.current = null;
        setCrawlRun(null);
        refreshList();
        if (id === activeId) loadActive(id);
      }
    });
  }, [activeId, loadActive, refreshList]);

  // initial load
  React.useEffect(() => {
    (async () => {
      const list = await refreshList();
      const active = list.find((c) => c.active) ?? list[0];
      if (active) {
        setActiveIdState(active.id);
        await loadActive(active.id);
        if (active.status === "running") watchProgress(active.id, active.startUrl);
      } else {
        setLoading(false);
      }
    })();
    return () => unsubRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setActiveId = React.useCallback((id: string) => {
    setActiveIdState(id);
    loadActive(id);
    api.setActive(id).then(() => refreshList());
  }, [loadActive, refreshList]);

  const startCrawl = React.useCallback(async (startUrl: string, maxDepth: number) => {
    const { id } = await api.startCrawl({ startUrl, maxDepth, render: false });
    await refreshList();
    setActiveIdState(id);
    watchProgress(id, startUrl);
  }, [refreshList, watchProgress]);

  const recrawl = React.useCallback(async (id: string) => {
    const result = await api.recrawl(id);
    await refreshList();
    setActiveIdState(result.id);
    const c = await api.getCrawl(result.id);
    watchProgress(result.id, c.startUrl);
  }, [refreshList, watchProgress]);

  const deleteCrawl = React.useCallback(async (id: string) => {
    await api.deleteCrawl(id);
    const list = await refreshList();
    if (id === activeId) {
      const next = list.find((c) => c.active) ?? list[0] ?? null;
      unsubRef.current?.();
      unsubRef.current = null;
      setCrawlRun(null);
      if (next) {
        setActiveIdState(next.id);
        await loadActive(next.id);
      } else {
        setActiveIdState(null);
        setSite(null);
      }
    }
  }, [activeId, loadActive, refreshList]);

  const refresh = React.useCallback(async () => {
    await refreshList();
    if (activeId) await loadActive(activeId);
  }, [activeId, loadActive, refreshList]);

  const value = React.useMemo<SiteCtx>(() => ({
    crawls, activeId, site, loading, crawlRun,
    setActiveId, startCrawl, recrawl, deleteCrawl, refresh,
  }), [crawls, activeId, site, loading, crawlRun, setActiveId, startCrawl, recrawl, deleteCrawl, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSite(): SiteCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useSite must be used within SiteProvider");
  return ctx;
}
