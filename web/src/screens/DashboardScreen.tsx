/* ============================================================
   Dashboard — クロール開始 / KPI / 重大な問題 / クロール管理 / 導線カード
   props: onNavigate(pageId)
   Ported from dashboard.jsx (window.SITE + simulated crawl → live SiteContext/SSE)
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { useSite } from "../lib/SiteContext";

export interface DashboardScreenProps {
  onNavigate: (page: string) => void;
}

export function DashboardScreen({ onNavigate }: DashboardScreenProps) {
  const { crawls, activeId, setActiveId, startCrawl, deleteCrawl, crawlRun, site } = useSite();
  const [url, setUrl] = React.useState("");
  const [depth, setDepth] = React.useState("3");

  const active = site?.crawl ?? crawls.find((c) => c.id === activeId) ?? crawls[0];

  const doStartCrawl = () => {
    if (crawlRun) return;
    const target = url.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") || "example.com";
    const startUrl = `https://${target}`;
    // サーバー（routes/crawls.ts の zod スキーマ）・クローラーエンジンともに
    // maxDepth: 0 = 無制限 として扱う。ここで 99 等の代用値に変換すると
    // スキーマの上限(max(10))を超えてバリデーションエラーになるため、0 をそのまま送る。
    const maxDepth = Number(depth);
    startCrawl(startUrl, maxDepth);
  };

  const doDelete = (c: { id: string; host: string; label: string }) => {
    if (!window.confirm(`「${c.host}」（${c.label}）のクロール結果を削除しますか？\nこの操作は取り消せません。`)) return;
    deleteCrawl(c.id);
  };

  if (!active) {
    return (
      <div className="db-wrap">
        <div className="db-inner">
          <div className="db-start">
            <div className="db-start-h">
              <span className="ic"><Icon.sitemap size={17} /></span>
              <b>新規クロール</b>
              <span className="pane-sub" style={{ marginLeft: 2 }}>URL を入力してサイト全体を解析します</span>
            </div>
            <div className="db-start-row">
              <div className="db-url">
                <Icon.home size={16} style={{ color: "var(--text-3)", flex: "none" }} />
                <span className="proto">https://</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com" onKeyDown={(e) => e.key === "Enter" && doStartCrawl()} />
              </div>
              <label className="db-depth">
                深さ
                <select value={depth} onChange={(e) => setDepth(e.target.value)}>
                  <option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="0">無制限</option>
                </select>
              </label>
              <button className="btn primary db-start-btn" onClick={doStartCrawl} disabled={!!crawlRun}>
                {crawlRun ? <><Icon.refresh size={15} /> 解析中…</> : <><Icon.refresh size={15} /> クロール開始</>}
              </button>
            </div>
            {crawlRun && (
              <div className="db-progress">
                <div className="db-prog-top">
                  <span style={{ color: "var(--text-2)" }}>クロール中 <span className="mono">{crawlRun.url}{crawlRun.cur || ""}</span></span>
                  <b>{Math.round(crawlRun.pct)}%</b>
                </div>
                <div className="db-prog-bar"><div className="db-prog-fill" style={{ width: crawlRun.pct + "%" }} /></div>
                <div className="db-prog-meta">
                  <span>発見 URL <b>{crawlRun.found}</b> / {crawlRun.total}</span>
                  <span>キュー <b>{crawlRun.queue}</b></span>
                  <span>速度 <b>~{crawlRun.speed}</b> URL/s</span>
                </div>
              </div>
            )}
          </div>
          <div className="pane-sub" style={{ padding: 24, textAlign: "center" }}>クロール結果がありません。上のフォームから新規クロールを開始してください。</div>
        </div>
      </div>
    );
  }

  const KPI = [
    { k: "pages", label: "ページ", val: active.pages, icon: "pages", color: "var(--primary)", weak: "var(--primary-weak)", go: "pages" },
    { k: "errors", label: "エラー", val: active.errors, icon: "errors", color: "var(--err)", weak: "var(--err-weak)", go: "errors" },
    { k: "redirects", label: "リダイレクト", val: active.redirects, icon: "redirects", color: "var(--info)", weak: "var(--info-weak)", go: "redirects" },
    { k: "orphans", label: "孤立ページ", val: active.orphans, icon: "sitemap", color: "var(--warn)", weak: "var(--warn-weak)", go: "sitemap" },
  ];

  const CRIT = [
    { name: "404・エラーページ", desc: "リンク切れ・サーバーエラー", count: active.errors, cls: "err", icon: "errors", go: "errors" },
    { name: "孤立ページ", desc: "内部リンクが存在しない", count: active.orphans, cls: "warn", icon: "sitemap", go: "sitemap" },
    { name: "リダイレクト", desc: "3xx 転送・チェーン", count: active.redirects, cls: "info", icon: "redirects", go: "redirects" },
    { name: "タイトル重複", desc: "同一 title の複数ページ", count: active.dup, cls: "violet", icon: "pages", go: "pages" },
  ];

  const TOOLS = [
    { go: "sitemap", name: "サイトマップ", icon: "sitemap", color: "var(--primary)", weak: "var(--primary-weak)", desc: "サイト構造をツリーで可視化。孤立ページや階層の深さを即座に把握。" },
    { go: "pages", name: "ページ一覧", icon: "pages", color: "#0772a8", weak: "var(--info-weak)", desc: "全URLを高密度テーブルで。検索・ソート・フィルタ・CSV出力に対応。" },
    { go: "links", name: "リンク構造", icon: "links", color: "#6526c4", weak: "var(--violet-weak)", desc: "内部リンクをグラフで可視化。リンク切れの影響範囲を追跡。" },
    { go: "errors", name: "エラー", icon: "errors", color: "var(--err)", weak: "var(--err-weak)", desc: "404 / 500 などの問題ページを一覧化。被リンク数で優先度を判断。" },
    { go: "redirects", name: "リダイレクト", icon: "redirects", color: "var(--warn)", weak: "var(--warn-weak)", desc: "3xx の転送元・先とチェーン深さを管理。冗長な転送を発見。" },
    { go: "export", name: "エクスポート", icon: "export", color: "#15803d", weak: "var(--ok-weak)", desc: "Excel（まとめて）/ CSV（個別）でレポート出力。監査資料に。" },
  ];

  return (
    <div className="db-wrap">
      <div className="db-inner">
        {/* ===== start crawl ===== */}
        <div className="db-start">
          <div className="db-start-h">
            <span className="ic"><Icon.sitemap size={17} /></span>
            <b>新規クロール</b>
            <span className="pane-sub" style={{ marginLeft: 2 }}>URL を入力してサイト全体を解析します</span>
          </div>
          <div className="db-start-row">
            <div className="db-url">
              <Icon.home size={16} style={{ color: "var(--text-3)", flex: "none" }} />
              <span className="proto">https://</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com" onKeyDown={(e) => e.key === "Enter" && doStartCrawl()} />
            </div>
            <label className="db-depth">
              深さ
              <select value={depth} onChange={(e) => setDepth(e.target.value)}>
                <option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="0">無制限</option>
              </select>
            </label>
            <button className="btn primary db-start-btn" onClick={doStartCrawl} disabled={!!crawlRun}>
              {crawlRun ? <><Icon.refresh size={15} /> 解析中…</> : <><Icon.refresh size={15} /> クロール開始</>}
            </button>
          </div>

          {crawlRun && (
            <div className="db-progress">
              <div className="db-prog-top">
                <span style={{ color: "var(--text-2)" }}>クロール中 <span className="mono">{crawlRun.url}{crawlRun.cur || ""}</span></span>
                <b>{Math.round(crawlRun.pct)}%</b>
              </div>
              <div className="db-prog-bar"><div className="db-prog-fill" style={{ width: crawlRun.pct + "%" }} /></div>
              <div className="db-prog-meta">
                <span>発見 URL <b>{crawlRun.found}</b> / {crawlRun.total}</span>
                <span>キュー <b>{crawlRun.queue}</b></span>
                <span>速度 <b>~{crawlRun.speed}</b> URL/s</span>
              </div>
            </div>
          )}
        </div>

        {active.truncated && (
          <div className="db-truncated-note">
            <Icon.errors size={15} />
            <span>このクロールは途中で打ち切られました（{active.pages.toLocaleString()} 件取得済）。サイト全体を網羅していない可能性があります。再クロールすると改善することがあります。</span>
          </div>
        )}

        {/* ===== KPI ===== */}
        <div className="db-sec-h"><h2>{active.host} の概要</h2><span className="pane-sub">最終クロール {active.when}</span></div>
        <div className="db-kpis">
          {KPI.map((c) => (
            <div key={c.k} className="db-kpi" onClick={() => onNavigate(c.go)}>
              <div className="db-kpi-top">
                <span className="db-kpi-ic" style={{ background: c.weak, color: c.color }}>{React.createElement(Icon[c.icon], { size: 16 })}</span>
                <Icon.arrowRight size={15} style={{ color: "var(--text-3)" }} />
              </div>
              <div className="db-kpi-v" style={{ color: c.k === "errors" && c.val > 0 ? "var(--err)" : "var(--text)" }}>{c.val}</div>
              <div className="db-kpi-l">{c.label}</div>
            </div>
          ))}
        </div>

        {/* ===== two columns ===== */}
        <div className="db-grid" style={{ marginTop: 18 }}>
          {/* critical issues */}
          <div className="db-panel">
            <div className="db-panel-h"><Icon.errors size={15} style={{ color: "var(--err)" }} /><b>重大な問題</b><span className="pane-sub">クリックで該当画面へ</span></div>
            {CRIT.map((c) => (
              <div key={c.name} className="ci-row" onClick={() => onNavigate(c.go)}>
                <span className="ci-ic" style={{ background: `var(--${c.cls}-weak)`, color: `var(--${c.cls})` }}>{React.createElement(Icon[c.icon], { size: 16 })}</span>
                <div className="ci-tx"><div className="ci-name">{c.name}</div><div className="ci-desc">{c.desc}</div></div>
                <span className="ci-count" style={{ color: c.count > 0 ? `var(--${c.cls})` : "var(--text-3)" }}>{c.count}</span>
                <Icon.chevron size={16} />
              </div>
            ))}
          </div>

          {/* crawl management */}
          <div className="db-panel">
            <div className="db-panel-h"><Icon.layers size={15} style={{ color: "var(--primary)" }} /><b>クロール結果</b><span className="pane-sub">{crawls.length} 件</span></div>
            {crawls.map((c) => (
              <div key={c.id} className={"cl-row" + (c.id === activeId ? " active" : "")} onClick={() => setActiveId(c.id)} onDoubleClick={() => onNavigate("sitemap")}>
                <span className="cl-fav">{c.host[0].toUpperCase()}</span>
                <div className="cl-tx">
                  <div className="cl-host">
                    {c.host}
                    {c.truncated && <span className="badge warn" style={{ marginLeft: 6, fontSize: 10, height: 16 }}>打ち切り</span>}
                  </div>
                  <div className="cl-meta">{c.label} ・ {c.pages} URL ・ {c.when}</div>
                </div>
                <button className="cl-open" onClick={(e) => { e.stopPropagation(); setActiveId(c.id); onNavigate("sitemap"); }}>開く →</button>
                <button className="cl-del" title="このクロール結果を削除" onClick={(e) => { e.stopPropagation(); doDelete(c); }}><Icon.close size={13} /></button>
                <div className="cl-health">
                  <div className="cl-health-v" style={{ color: c.health >= 90 ? "var(--ok)" : c.health >= 80 ? "var(--warn)" : "var(--err)" }}>{c.health}</div>
                  <div className="cl-health-l">健全性</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===== tool cards ===== */}
        <div className="db-sec-h"><h2>ツール</h2></div>
        <div className="db-tools">
          {TOOLS.map((t) => (
            <button key={t.go} className="db-tool" onClick={() => onNavigate(t.go)}>
              <span className="db-tool-ic" style={{ background: t.weak, color: t.color }}>{React.createElement(Icon[t.icon], { size: 19 })}</span>
              <div className="db-tool-name">{t.name}</div>
              <div className="db-tool-desc">{t.desc}</div>
              <span className="go">開く <Icon.arrowRight size={13} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
