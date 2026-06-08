/* ============================================================
   Orphans (孤立ページ) screen
   Ported from issuelists.jsx (window.SITE → useSite() context)
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { statusOf, buildCSV, downloadFile, orphanReason } from "../lib/common";
import { SimpleTable, type SimpleCol } from "../components/SimpleTable";
import { useSite } from "../lib/SiteContext";

export function OrphansScreen() {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  const host = site?.host ?? "";
  const [q, setQ] = React.useState("");
  const all = flat.filter((n) => n.issues.includes("orphan"));
  const rows = all.filter((n) => (n.url + n.title).toLowerCase().includes(q.trim().toLowerCase()));

  const cols: SimpleCol[] = [
    { key: "status", label: "ステータス", w: 96, sort: (n) => n.status, num: true, render: (n) => <span className={"badge " + statusOf(n).cls}>{n.status}</span> },
    { key: "url", label: "URL", w: 300, sort: (n) => n.url, render: (n) => <span className="c-url">{n.url}</span> },
    { key: "title", label: "タイトル", w: 230, sort: (n) => n.title || "", render: (n) => n.title || <span className="c-muted">— 未設定 —</span> },
    { key: "inLinks", label: "被リンク", w: 96, align: "right", num: true, sort: (n) => n.inLinks, render: (n) => <span className="tnum" style={{ color: "var(--err)", fontWeight: 600 }}>{n.inLinks}</span> },
    { key: "noindex", label: "Index", w: 92, align: "center", sort: (n) => n.noindex ? 1 : 0, render: (n) => n.noindex ? <span className="badge violet">Noindex</span> : <span className="c-muted">index</span> },
    { key: "reason", label: "孤立の理由", w: 220, render: (n) => <span style={{ color: "var(--text-2)", fontSize: 12 }}>{orphanReason(n)}</span> },
    { key: "depth", label: "階層", w: 68, align: "center", num: true, sort: (n) => n.depth, render: (n) => <span className="tnum">{n.depth}</span> },
  ];

  return (
    <div className="il-wrap">
      <div className="il-bar">
        <span className="il-ic" style={{ background: "var(--warn-weak)", color: "var(--warn)" }}><Icon.sitemap size={17} /></span>
        <div><h1>孤立ページ</h1><div className="il-sub">内部リンクが1つも向いていないページ。クロール／導線から孤立しています。</div></div>
        <span className="il-spacer" />
        <div className="il-chips">
          <span className="il-chip"><span className="sw" style={{ background: "var(--warn)" }} />孤立 <b>{all.length}</b></span>
          <span className="il-chip"><span className="sw" style={{ background: "var(--violet)" }} />うち noindex <b>{all.filter((n) => n.noindex).length}</b></span>
        </div>
      </div>
      <div className="il-tools">
        <div className="search" style={{ width: 280 }}>
          <Icon.search size={15} /><input placeholder="URL・タイトルを検索…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => downloadFile(`orphans_${host}.csv`, buildCSV(["URL", "ステータス", "タイトル", "被リンク", "Noindex", "孤立の理由", "階層"], rows.map((n) => [n.url, n.status, n.title, n.inLinks, n.noindex ? "noindex" : "index", orphanReason(n), n.depth])))}><Icon.export size={13} /> CSV出力</button>
      </div>
      <SimpleTable cols={cols} rows={rows} empty={<div className="pane-sub" style={{ padding: 40, textAlign: "center" }}>孤立ページはありません 🎉</div>} />
      <div className="pg-foot"><span><b>{rows.length}</b> 件の孤立ページ</span></div>
    </div>
  );
}
