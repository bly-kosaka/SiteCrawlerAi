/* ============================================================
   Redirects screen — chain visualization
   Ported from issuelists.jsx (window.SITE → useSite() context)
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { statusOf, statusClass, buildCSV, downloadFile } from "../lib/common";
import { useSite } from "../lib/SiteContext";
import type { PageNode } from "../lib/types";

interface Hop { url: string; status: number; }

export function RedirectsScreen() {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  const host = site?.host ?? "";
  const byUrl = React.useMemo(() => Object.fromEntries(flat.map((n) => [n.url, n])), [flat]);
  const all = flat.filter((n) => [301, 302].includes(n.status));

  const chainOf = (n: PageNode): Hop[] => {
    const hops: Hop[] = [{ url: n.url, status: n.status }];
    let cur: PageNode | undefined = n, guard = 0;
    while (cur && cur.redirectTo && guard < 8) {
      const next: PageNode | undefined = byUrl[cur.redirectTo];
      hops.push({ url: cur.redirectTo, status: next ? next.status : 404 });
      if (!next || ![301, 302].includes(next.status)) break;
      cur = next; guard++;
    }
    return hops;
  };

  const by = (code: number) => all.filter((n) => n.status === code).length;
  const chains = all.map((n) => ({ node: n, hops: chainOf(n) }));
  const multiHop = chains.filter((c) => c.hops.length > 2).length;

  return (
    <div className="il-wrap">
      <div className="il-bar">
        <span className="il-ic" style={{ background: "var(--info-weak)", color: "var(--info)" }}><Icon.redirects size={17} /></span>
        <div><h1>リダイレクト</h1><div className="il-sub">3xx の転送元・転送先とチェーン。内部リンクは最終URLへ張り替えるのが理想です。</div></div>
        <span className="il-spacer" />
        <div className="il-chips">
          <span className="il-chip"><span className="sw" style={{ background: "var(--info)" }} />301 <b>{by(301)}</b></span>
          <span className="il-chip"><span className="sw" style={{ background: "var(--info)" }} />302 <b>{by(302)}</b></span>
          <span className="il-chip"><span className="sw" style={{ background: "var(--warn)" }} />2段以上 <b>{multiHop}</b></span>
        </div>
      </div>
      <div className="il-tools">
        <span className="pane-sub" style={{ alignSelf: "center" }}>転送元 → 中間 → 最終URL の流れを表示</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => downloadFile(`redirects_${host}.csv`, buildCSV(["リンク元URL", "リダイレクト先", "ステータス", "チェーン深さ"], all.map((n) => [n.url, n.redirectTo || "", n.status, chainOf(n).length - 1])))}><Icon.export size={13} /> CSV出力</button>
      </div>
      <div className="rc-scroll">
        {chains.map(({ node, hops }) => (
          <div key={node.id} className="rc-card">
            <span className={"badge " + statusOf(node).cls + " rc-status"}>{node.status}</span>
            <div className="rc-flow">
              {hops.map((h, i) => {
                const last = i === hops.length - 1;
                const bad = last && h.status !== 200;
                return (
                  <React.Fragment key={i}>
                    <span className={"rc-hop" + (i === 0 ? " start" : last ? " end" + (bad ? " bad" : "") : "")}>
                      <span className={"dot-s " + statusClass(h.status)} />
                      <span className="u">{host}{h.url}</span>
                      {!(i === 0) && <span style={{ fontSize: 10, opacity: .8 }}>{h.status}</span>}
                    </span>
                    {!last && <Icon.arrowRight size={15} />}
                  </React.Fragment>
                );
              })}
            </div>
            <div className="rc-meta">
              <div className={"rc-depth" + (hops.length > 2 ? " warn" : "")}>
                <div className="v">{hops.length - 1}</div>
                <div className="l">ホップ</div>
              </div>
            </div>
          </div>
        ))}
        {chains.length === 0 && <div className="pane-sub" style={{ padding: 40, textAlign: "center" }}>リダイレクトはありません。</div>}
      </div>
      <div className="pg-foot"><span><b>{all.length}</b> 件のリダイレクト</span>{multiHop > 0 && <span style={{ color: "var(--warn)" }}>・ <b style={{ color: "var(--warn)" }}>{multiHop}</b> 件は2段以上のチェーン</span>}</div>
    </div>
  );
}
