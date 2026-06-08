/* ============================================================
   Shell — fixed brand bar, header, sidebar navigation
   Ported from shell.jsx (window globals → module exports)
   ============================================================ */
import React from "react";
import { Icon } from "./icons";

export const NAV = [
  { group: "概要", items: [
    { id: "dashboard", label: "ダッシュボード", icon: "dashboard" },
  ] },
  { group: "探索", items: [
    { id: "sitemap", label: "サイトマップ", icon: "sitemap" },
    { id: "pages", label: "ページ一覧", icon: "pages", countKey: "pages" },
    { id: "links", label: "リンク構造", icon: "links" },
  ] },
  { group: "問題", items: [
    { id: "errors", label: "エラー", icon: "errors", countKey: "errors", danger: true },
    { id: "redirects", label: "リダイレクト", icon: "redirects", countKey: "redirects" },
    { id: "orphans", label: "孤立ページ", icon: "sitemap", countKey: "orphans" },
  ] },
  { group: "出力", items: [
    { id: "export", label: "エクスポート", icon: "export" },
  ] },
] as const;

export function Brandbar() {
  return (
    <div className="brandbar">
      <div className="brand-logo">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="2.5" width="6" height="5" rx="1.4" />
          <rect x="2.5" y="16.5" width="6" height="5" rx="1.4" />
          <rect x="15.5" y="16.5" width="6" height="5" rx="1.4" />
          <path d="M12 7.5v4M12 11.5H5.5v5M12 11.5h6.5v5" />
        </svg>
      </div>
      <div className="brand-name">Site<b>Mapper</b></div>
      <span className="badge muted" style={{ marginLeft: 2, height: 17, fontSize: 10 }}>AI</span>
    </div>
  );
}

interface HeaderProps {
  page: string;
  host: string;
  pages: number;
  when: string;
  crawlId: string;
  onRecrawl: () => void;
  onLogout: () => void;
}

export function Header({ page, host, pages, when, crawlId, onRecrawl, onLogout }: HeaderProps) {
  const titles: Record<string, string> = {
    dashboard: "ダッシュボード", sitemap: "サイトマップ", pages: "ページ一覧",
    links: "リンク構造", errors: "エラー", redirects: "リダイレクト", orphans: "孤立ページ", export: "エクスポート",
  };
  const [share, setShare] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const shareUrl = `https://app.sitemapper.ai/share/${host.replace(/\./g, "-")}/${crawlId}`;
  const copy = () => {
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  const showTweaks = () => window.postMessage({ type: "__activate_edit_mode" }, "*");

  return (
    <div className="header">
      <button className="chip" style={{ height: 32, fontWeight: 600, color: "var(--text)" }}>
        <span className="dot-s ok" />
        <span className="mono" style={{ fontSize: 12.5 }}>{host}</span>
        <Icon.chevronDown size={14} style={{ color: "var(--text-3)" }} />
      </button>

      <span style={{ color: "var(--text-3)" }}>/</span>
      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{titles[page]}</span>

      <span className="pane-sub" style={{ marginLeft: 4 }}>
        最終クロール <b style={{ color: "var(--text-2)", fontWeight: 600 }}>{when}</b> ・ {pages} URL
      </span>

      <div style={{ flex: 1 }} />

      <div className="search" style={{ width: 220 }}>
        <Icon.search size={15} />
        <input placeholder="URL・タイトルを検索…" />
        <span className="kbd">/</span>
      </div>

      <button className="btn icon" title="Tweaks パネルを表示" onClick={showTweaks}>
        <Icon.settings size={16} style={{ color: "var(--text-2)" }} />
      </button>

      <button className="btn" title="ログアウト" onClick={onLogout}>ログアウト</button>

      <div style={{ position: "relative" }}>
        <button className="btn" onClick={() => setShare((v) => !v)}>
          <Icon.share size={15} /> 共有
        </button>
        {share && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setShare(false)} />
            <div className="share-pop">
              <div className="share-h">
                <span style={{ fontWeight: 650, fontSize: 13 }}>レポートを共有</span>
                <button className="btn ghost icon sm" onClick={() => setShare(false)}><Icon.close size={14} /></button>
              </div>
              <div className="share-sub">このクロール結果へのリンクを発行します。リンクを知っている人が閲覧できます。</div>
              <div className="share-url">
                <Icon.link size={14} style={{ color: "var(--text-3)", flex: "none" }} />
                <span className="mono">{shareUrl}</span>
              </div>
              <div className="share-actions">
                <span className="share-access"><span className="dot-s ok" /> 閲覧のみ・期限なし</span>
                <button className={"btn primary sm" + (copied ? " ok" : "")} onClick={copy}>
                  {copied ? <><Icon.check size={14} /> コピーしました</> : <><Icon.copy size={14} /> リンクをコピー</>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <button className="btn icon" title="通知" style={{ position: "relative" }}>
        <Icon.bell size={16} style={{ color: "var(--text-2)" }} />
        <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: 99, background: "var(--err)" }} />
      </button>
      <button className="btn primary" onClick={onRecrawl}>
        <Icon.refresh size={15} /> 再クロール
      </button>
    </div>
  );
}

interface SidebarProps {
  page: string;
  onNavigate: (id: string) => void;
  counts: Record<string, number>;
  health: number;
}

export function Sidebar({ page, onNavigate, counts, health }: SidebarProps) {
  return (
    <nav className="sidebar">
      {NAV.map((grp) => (
        <div key={grp.group}>
          <div className="nav-group-label">{grp.group}</div>
          {grp.items.map((it) => {
            const Ico = Icon[it.icon];
            const active = page === it.id;
            const n = "countKey" in it && it.countKey ? counts[it.countKey] : null;
            const danger = "danger" in it && it.danger;
            return (
              <button
                key={it.id}
                className={"nav-item" + (active ? " active" : "")}
                onClick={() => onNavigate(it.id)}
              >
                <Ico size={17} />
                {it.label}
                {n != null && n > 0 && (
                  <span className={"count" + (danger ? " err" : "")}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <div style={{ margin: "8px 4px 0", padding: "10px 11px", border: "1px solid var(--border)", borderRadius: "var(--r-md)", background: "var(--surface-2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--text-2)" }}>クロール健全性</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ok)" }}>{health}<span style={{ color: "var(--text-3)", fontWeight: 600 }}>/100</span></span>
        </div>
        <div style={{ height: 5, borderRadius: 99, background: "var(--surface-3)", overflow: "hidden" }}>
          <div style={{ width: `${health}%`, height: "100%", background: "linear-gradient(90deg,var(--ok),#34d399)" }} />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-3)", display: "flex", gap: 10 }}>
          <span><span className="dot-s err" style={{ marginRight: 4 }} />エラー {counts.errors}</span>
          <span><span className="dot-s warn" style={{ marginRight: 4 }} />孤立 {counts.orphans}</span>
        </div>
      </div>
    </nav>
  );
}
