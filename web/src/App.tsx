/* ============================================================
   App — composes shell + active screen, wires Tweaks
   Ported from app.jsx (window.SITE → SiteProvider/useSite())
   ============================================================ */
import React from "react";
import { Icon } from "./components/icons";
import { Brandbar, Header, Sidebar } from "./components/shell";
import {
  useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor,
} from "./components/tweaks-panel";
import { SiteProvider, useSite } from "./lib/SiteContext";
import { LoginScreen } from "./components/LoginScreen";
import { checkSession, logout } from "./lib/api";
import { SitemapScreen } from "./screens/SitemapScreen";
import { PagesScreen } from "./screens/PagesScreen";
import { LinksScreen } from "./screens/LinksScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ExportScreen } from "./screens/ExportScreen";
import { ErrorsScreen } from "./screens/ErrorsScreen";
import { OrphansScreen } from "./screens/OrphansScreen";
import { RedirectsScreen } from "./screens/RedirectsScreen";

const TWEAK_DEFAULTS = {
  density: "compact",
  treeMode: "title",
  detailMode: "stacked",
  accent: "#2563eb",
};

const DENSITY: Record<string, Record<string, string>> = {
  compact: { "--row-h": "29px", "--row-fs": "13px" },
  cozy: { "--row-h": "34px", "--row-fs": "13.5px" },
};

// URLのハッシュ(#/pages 等)で画面状態を表現する。
// これにより、ディープリンク(URL共有)とブラウザの戻る/進むナビゲーションに対応できる。
// SPA全体でルーターライブラリを導入するほどの規模ではないため、最小限のハッシュ監視で実現する。
const ROUTABLE_PAGES = new Set([
  "dashboard", "sitemap", "pages", "links", "errors", "redirects", "orphans", "export",
]);

function pageFromHash(): string {
  const raw = location.hash.replace(/^#\/?/, "");
  return ROUTABLE_PAGES.has(raw) ? raw : "dashboard";
}

function useHashRoute(): [string, (page: string) => void] {
  const [page, setPageState] = React.useState(pageFromHash);

  React.useEffect(() => {
    const onHashChange = () => setPageState(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = React.useCallback((next: string) => {
    const current = location.hash.replace(/^#\/?/, "");
    if (current !== next) location.hash = `/${next}`;
    setPageState(next);
  }, []);

  return [page, navigate];
}

function Placeholder({ page }: { page: string }) {
  const labels: Record<string, string> = { dashboard: "ダッシュボード", pages: "ページ一覧", links: "リンク構造", errors: "エラー", redirects: "リダイレクト", export: "エクスポート" };
  const icons: Record<string, string> = { links: "links", pages: "pages", errors: "errors", redirects: "redirects", export: "export", dashboard: "dashboard" };
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", textAlign: "center" }}>
      <div style={{ maxWidth: 380 }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--surface-3)", display: "grid", placeItems: "center", margin: "0 auto 16px", color: "var(--text-3)" }}>
          {React.createElement(Icon[icons[page]], { size: 24 })}
        </div>
        <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 650 }}>{labels[page]}</h2>
        <p className="pane-sub" style={{ lineHeight: 1.6 }}>
          この画面は次のステップで作成します。まず <b style={{ color: "var(--text-2)" }}>サイトマップ</b> を基準にし、そのツリー・ステータス体系・詳細パネルを他画面に展開していきます。
        </p>
      </div>
    </div>
  );
}

function AppInner({ onLogout }: { onLogout: () => void }) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page, setPage] = useHashRoute();
  const { site, activeId, recrawl } = useSite();

  React.useEffect(() => {
    const r = document.documentElement;
    const d = DENSITY[t.density as string] || DENSITY.compact;
    Object.entries(d).forEach(([k, v]) => r.style.setProperty(k, v));
    r.style.setProperty("--primary", t.accent as string);
  }, [t.density, t.accent]);

  const counts = site?.counts ?? { pages: 0, ok: 0, errors: 0, redirects: 0, orphans: 0, noindex: 0, dupTitles: 0 };
  const health = site?.summary.health ?? 0;

  return (
    <div className="app">
      <Brandbar />
      <Header
        page={page}
        host={site?.host ?? ""}
        pages={counts.pages}
        when={site?.crawl.when ?? ""}
        crawlId={site?.crawl.id ?? ""}
        onRecrawl={() => activeId && recrawl(activeId)}
        onLogout={onLogout}
      />
      <Sidebar page={page} onNavigate={setPage} counts={counts} health={health} />
      <main className="main">
        {page === "sitemap"
          ? <SitemapScreen treeMode={t.treeMode as "title" | "path"} detailMode={t.detailMode as "stacked" | "compact"} />
          : page === "pages"
          ? <PagesScreen />
          : page === "links"
          ? <LinksScreen />
          : page === "dashboard"
          ? <DashboardScreen onNavigate={setPage} />
          : page === "export"
          ? <ExportScreen />
          : page === "errors"
          ? <ErrorsScreen />
          : page === "redirects"
          ? <RedirectsScreen />
          : page === "orphans"
          ? <OrphansScreen />
          : <Placeholder page={page} />}
      </main>

      <TweaksPanel>
        <TweakSection label="サイトマップ — ツリー" />
        <TweakRadio label="ツリー表記" value={t.treeMode as string}
          options={[{ value: "title", label: "タイトル" }, { value: "path", label: "URLパス" }]}
          onChange={(v) => setTweak("treeMode", v)} />
        <TweakRadio label="行密度" value={t.density as string}
          options={[{ value: "compact", label: "高密度" }, { value: "cozy", label: "余白" }]}
          onChange={(v) => setTweak("density", v)} />
        <TweakSection label="詳細パネル" />
        <TweakRadio label="メタ情報のレイアウト" value={t.detailMode as string}
          options={[{ value: "stacked", label: "縦並び" }, { value: "compact", label: "グリッド" }]}
          onChange={(v) => setTweak("detailMode", v)} />
        <TweakSection label="テーマ" />
        <TweakColor label="アクセント" value={t.accent as string}
          options={["#2563eb", "#3b82f6", "#1d4ed8", "#0ea5e9"]}
          onChange={(v) => setTweak("accent", v)} />
      </TweaksPanel>
    </div>
  );
}

// ログインゲート: SiteProvider(初回マウント時にAPIへアクセスする)より前段で
// セッション(Cookie)の有無を確認する。未ログインのまま SiteProvider をマウントすると
// 各APIが軒並み401を返してしまうため、認証確認が完了するまでアプリ本体を描画しない。
type AuthState = "checking" | "authenticated" | "unauthenticated";

export default function App() {
  const [state, setState] = React.useState<AuthState>("checking");

  React.useEffect(() => {
    let cancelled = false;
    checkSession().then((ok) => {
      if (!cancelled) setState(ok ? "authenticated" : "unauthenticated");
    });
    return () => { cancelled = true; };
  }, []);

  const handleLogout = React.useCallback(() => {
    logout().finally(() => setState("unauthenticated"));
  }, []);

  if (state === "checking") {
    return <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }} />;
  }
  if (state === "unauthenticated") {
    return <LoginScreen onSuccess={() => setState("authenticated")} />;
  }
  return (
    <SiteProvider>
      <AppInner onLogout={handleLogout} />
    </SiteProvider>
  );
}
