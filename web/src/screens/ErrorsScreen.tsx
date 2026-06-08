/* ============================================================
   Errors screen — 4xx/5xx pages
   Ported from issuelists.jsx (window.SITE → useSite() context)
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { statusOf, buildCSV, downloadFile } from "../lib/common";
import { SimpleTable, impactOf, type SimpleCol } from "../components/SimpleTable";
import { useSite } from "../lib/SiteContext";

export function ErrorsScreen() {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  const host = site?.host ?? "";
  const [q, setQ] = React.useState("");
  const all = flat.filter((n) => [404, 410, 500].includes(n.status));
  const rows = all.filter((n) => (n.url + n.title).toLowerCase().includes(q.trim().toLowerCase()));
  const by = (code: number) => all.filter((n) => n.status === code).length;

  const cols: SimpleCol[] = [
    { key: "status", label: "ステータス", w: 96, sort: (n) => n.status, num: true, render: (n) => <span className={"badge " + statusOf(n).cls}>{n.status}</span> },
    { key: "url", label: "URL", w: 360, sort: (n) => n.url, render: (n) => <span className="c-url">{n.url}</span> },
    { key: "type", label: "種別", w: 150, render: (n) => <span style={{ color: "var(--text-2)" }}>{statusOf(n).jp}</span> },
    { key: "inLinks", label: "被リンク", w: 100, align: "right", num: true, sort: (n) => n.inLinks, render: (n) => <span className="tnum" style={{ color: n.inLinks ? "var(--text)" : "var(--text-3)" }}>{n.inLinks}</span> },
    { key: "impact", label: "影響度", w: 110, sort: (n) => n.inLinks, num: true, render: (n) => { const im = impactOf(n); return <span className={"impact " + im.cls}><span className="sw" style={{ background: `var(--${im.cls === "high" ? "err" : im.cls === "mid" ? "warn" : "text-3"})` }} />{im.label}</span>; } },
    { key: "depth", label: "階層", w: 70, align: "center", num: true, sort: (n) => n.depth, render: (n) => <span className="tnum">{n.depth}</span> },
  ];

  return (
    <div className="il-wrap">
      <div className="il-bar">
        <span className="il-ic" style={{ background: "var(--err-weak)", color: "var(--err)" }}><Icon.errors size={17} /></span>
        <div><h1>エラー</h1><div className="il-sub">4xx / 5xx を返すページ。被リンク数が多いほど優先的に修正。</div></div>
        <span className="il-spacer" />
        <div className="il-chips">
          <span className="il-chip"><span className="sw" style={{ background: "var(--err)" }} />404 <b>{by(404)}</b></span>
          <span className="il-chip"><span className="sw" style={{ background: "var(--err)" }} />410 <b>{by(410)}</b></span>
          <span className="il-chip"><span className="sw" style={{ background: "var(--err)" }} />500 <b>{by(500)}</b></span>
        </div>
      </div>
      <div className="il-tools">
        <div className="search" style={{ width: 280 }}>
          <Icon.search size={15} /><input placeholder="URL・タイトルを検索…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => downloadFile(`errors_${host}.csv`, buildCSV(["URL", "ステータス", "種別", "被リンク", "階層"], rows.map((n) => [n.url, n.status, statusOf(n).jp, n.inLinks, n.depth])))}><Icon.export size={13} /> CSV出力</button>
      </div>
      <SimpleTable cols={cols} rows={rows} empty={<div className="pane-sub" style={{ padding: 40, textAlign: "center" }}>エラーはありません 🎉</div>} />
      <div className="pg-foot"><span><b>{rows.length}</b> 件のエラー</span></div>
    </div>
  );
}
