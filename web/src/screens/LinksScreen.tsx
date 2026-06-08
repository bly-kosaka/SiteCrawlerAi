/* ============================================================
   Links — interactive internal-link graph
   layouts: tree(階層) | radial(放射) | force(力学)
   node color = status; click → right detail panel (shared)
   Ported from links.jsx (window.SITE → useSite() context)
   Custom SVG graph preserved verbatim (pan/zoom/drag/legend) —
   this keeps the exact pixel-level design the prototype defines.
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { statusOf, lastSeg } from "../lib/common";
import { DetailPanel } from "./SitemapScreen";
import { useSite } from "../lib/SiteContext";
import type { PageNode, PageTreeNode, Edge } from "../lib/types";

const STATUS_HEX: Record<string, string> = { ok: "#16a34a", info: "#0ea5e9", err: "#dc2626", warn: "#d97706", violet: "#7c3aed", muted: "#94a3b8" };
const EDGE_HEX: Record<string, string> = { tree: "#cbd5e1", nav: "#cbd5e1", footer: "#dbe2ea", context: "#c7d2e8", redirect: "#7cc4f0" };

const nodeColor = (n: PageNode) => {
  if (n.issues.includes("orphan")) return STATUS_HEX.warn;
  return STATUS_HEX[statusOf(n).cls] || STATUS_HEX.muted;
};
const nodeR = (n: PageNode) => Math.max(7, Math.min(26, 7 + Math.sqrt(n.inLinks) * 1.15));

type Pos = Record<string, { x: number; y: number }>;

/* ---------- layouts (return {id:{x,y}}) ---------- */
function treeLayout(root: PageTreeNode): Pos {
  const LG = 235, NG = 46; let ny = 0; const pos: Pos = {};
  (function place(n: PageTreeNode): number {
    const kids = n.children || [];
    if (!kids.length) { pos[n.id] = { x: n.depth * LG, y: ny * NG }; ny++; return pos[n.id].y; }
    const ys = kids.map(place);
    pos[n.id] = { x: n.depth * LG, y: (ys[0] + ys[ys.length - 1]) / 2 };
    return pos[n.id].y;
  })(root);
  return pos;
}
function radialLayout(root: PageTreeNode): Pos {
  const RG = 165; let leaves = 0;
  (function count(n: PageTreeNode) { const k = n.children || []; if (!k.length) leaves++; else k.forEach(count); })(root);
  let i = 0; const pos: Pos = {};
  (function place(n: PageTreeNode): number {
    const kids = n.children || [];
    let a: number;
    if (!kids.length) { a = (i / leaves) * Math.PI * 2; i++; }
    else { const as = kids.map(place); a = (as[0] + as[as.length - 1]) / 2; }
    const r = n.depth * RG;
    pos[n.id] = { x: Math.cos(a - Math.PI / 2) * r, y: Math.sin(a - Math.PI / 2) * r };
    return a;
  })(root);
  return pos;
}
// O(n²) のペアワイズ反発計算は、ノード数が増えると指数的に重くなる
// (例: 10,000ノード×420イテレーション ≈ 数百億回の演算となり、メインスレッドを長時間フリーズさせる)。
// Web Worker等の非同期化は本アプリの規模では過剰なため、現実的な対策として
// ・上限ノード数を超える場合は力学レイアウトの実行自体を見送り階層配置にフォールバックする
// ・上限以内でもノード数に応じてイテレーション回数を段階的に減らす
// という2段構えのガードを設ける。
export const FORCE_LAYOUT_MAX_NODES = 1500;
function forceIterationsFor(n: number): number {
  if (n <= 150) return 420;
  if (n <= 400) return 220;
  if (n <= 800) return 110;
  return 50;
}
function forceLayout(flat: PageNode[], edges: Edge[], seed: Pos): Pos {
  const pos: Pos = {};
  flat.forEach((n) => { const s = seed[n.id] || { x: 0, y: 0 }; pos[n.id] = { x: s.x * 0.4 + (Math.random() - .5) * 40, y: s.y * 0.4 + (Math.random() - .5) * 40 }; });
  const ids = flat.map((n) => n.id);
  const K = 165;
  let temp = 240;
  const ITERS = forceIterationsFor(ids.length);
  for (let it = 0; it < ITERS; it++) {
    const disp: Pos = {}; ids.forEach((id) => disp[id] = { x: 0, y: 0 });
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const pa = pos[ids[a]], pb = pos[ids[b]];
      const dx = pa.x - pb.x, dy = pa.y - pb.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (K * K) / d; const ux = dx / d, uy = dy / d;
      disp[ids[a]].x += ux * f; disp[ids[a]].y += uy * f;
      disp[ids[b]].x -= ux * f; disp[ids[b]].y -= uy * f;
    }
    edges.forEach((e) => {
      const pa = pos[e.s], pb = pos[e.t]; if (!pa || !pb) return;
      const dx = pa.x - pb.x, dy = pa.y - pb.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / K; const ux = dx / d, uy = dy / d;
      disp[e.s].x -= ux * f; disp[e.s].y -= uy * f;
      disp[e.t].x += ux * f; disp[e.t].y += uy * f;
    });
    ids.forEach((id) => {
      const dd = disp[id]; const len = Math.sqrt(dd.x * dd.x + dd.y * dd.y) || 0.01;
      const step = Math.min(len, temp);
      pos[id].x += (dd.x / len) * step; pos[id].y += (dd.y / len) * step;
    });
    let cx = 0, cy = 0; ids.forEach((id) => { cx += pos[id].x; cy += pos[id].y; });
    cx /= ids.length; cy /= ids.length;
    ids.forEach((id) => { pos[id].x -= cx; pos[id].y -= cy; });
    temp = Math.max(4, temp * 0.985);
  }
  return pos;
}

interface View { x: number; y: number; k: number; }
type DragState =
  | { mode: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { mode: "node"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean };

export function LinksScreen() {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  const TREE = site?.tree ?? null;
  const edges = site?.edges ?? [];
  const host = site?.host ?? "";

  const byId = React.useMemo(() => Object.fromEntries(flat.map((n) => [n.id, n])), [flat]);
  const [layout, setLayout] = React.useState("tree");
  const [pos, setPos] = React.useState<Pos>({});
  const [view, setView] = React.useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const drag = React.useRef<DragState | null>(null);

  const fitView = React.useCallback((p: Pos) => {
    const svg = svgRef.current; if (!svg || !p || Object.keys(p).length !== flat.length || !flat.length) return;
    const rect = svg.getBoundingClientRect();
    const xs = flat.map((n) => p[n.id].x), ys = flat.map((n) => p[n.id].y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const bw = (maxX - minX) || 1, bh = (maxY - minY) || 1;
    const insT = 66, insB = 20, insL = 24, insR = 24;
    const availW = rect.width - insL - insR, availH = rect.height - insT - insB;
    const k = Math.min(availW / bw, availH / bh, 1.4);
    const x = insL + (availW - bw * k) / 2 - minX * k;
    const y = insT + (availH - bh * k) / 2 - minY * k;
    setView({ x, y, k });
  }, [flat]);

  const forceTooLarge = layout === "force" && flat.length > FORCE_LAYOUT_MAX_NODES;

  React.useEffect(() => {
    if (!TREE || !flat.length) return;
    let p: Pos;
    if (layout === "tree") p = treeLayout(TREE);
    else if (layout === "radial") p = radialLayout(TREE);
    else if (forceTooLarge) p = treeLayout(TREE); // ノード数が多すぎる場合はO(n²)シミュレーションを行わずフォールバック
    else p = forceLayout(flat, edges, treeLayout(TREE));
    setPos(p);
    requestAnimationFrame(() => fitView(p));
  }, [layout, TREE, flat, edges, fitView, forceTooLarge]);

  React.useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const k = Math.max(0.2, Math.min(3, v.k * factor));
        const r = k / v.k;
        return { k, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    setView((v) => { const k = Math.max(0.2, Math.min(3, v.k * f)); const r = k / v.k; return { k, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r }; });
  };

  const onBgDown = (e: React.MouseEvent) => {
    if ((e.target as Element).closest(".lk-node")) return;
    setSelected(null);
    drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  };
  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    drag.current = { mode: "node", id, sx: e.clientX, sy: e.clientY, ox: pos[id].x, oy: pos[id].y, moved: false };
  };
  React.useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current; if (!d) return;
      if (d.mode === "pan") setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }));
      else {
        const k = view.k; const nx = d.ox + (e.clientX - d.sx) / k, ny = d.oy + (e.clientY - d.sy) / k;
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
        setPos((p) => ({ ...p, [d.id]: { x: nx, y: ny } }));
      }
    };
    const up = () => {
      const d = drag.current; if (d && d.mode === "node" && !d.moved) setSelected(d.id);
      drag.current = null;
      svgRef.current?.classList.remove("panning");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [view.k]);

  const LAYOUTS = [{ id: "tree", label: "階層" }, { id: "radial", label: "放射" }, { id: "force", label: "力学" }];

  const activeId = hover || selected;
  const adj = React.useMemo(() => {
    if (!activeId) return null;
    const s = new Set<string>([activeId]);
    edges.forEach((e) => { if (e.s === activeId) s.add(e.t); if (e.t === activeId) s.add(e.s); });
    return s;
  }, [activeId, edges]);

  const ready = flat.length > 0 && Object.keys(pos).length === flat.length;
  const selNode = selected ? byId[selected] : null;

  if (!TREE) {
    return <div className="lk-layout"><div className="pane-sub" style={{ padding: 40 }}>クロールデータを読み込み中…</div></div>;
  }

  return (
    <div className="lk-layout">
      <div className="lk-main">
        {/* toolbar */}
        <div className="lk-toolbar">
          <div className="lk-card">
            <div className="seg lk-seg">
              {LAYOUTS.map((l) => (
                <button key={l.id} className={layout === l.id ? "on" : ""} onClick={() => setLayout(l.id)}>{l.label}</button>
              ))}
            </div>
          </div>
          <div className="lk-card" style={{ padding: "5px 11px", gap: 8 }}>
            <Icon.links size={15} style={{ color: "var(--primary)" }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{flat.length}</span>
            <span className="pane-sub">ノード</span>
            <span style={{ width: 1, height: 14, background: "var(--border-strong)" }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{edges.length}</span>
            <span className="pane-sub">エッジ</span>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn sm lk-card" style={{ border: "1px solid var(--border-strong)" }} onClick={() => fitView(pos)}>
            <Icon.expand size={14} style={{ transform: "rotate(45deg)" }} /> 全体表示
          </button>
        </div>

        {forceTooLarge && (
          <div className="lk-force-note">
            <Icon.errors size={14} />
            ノード数（{flat.length.toLocaleString()}）が多いため、力学レイアウトの計算は負荷が大きく実行できません。代わりに階層レイアウトを表示しています。
          </div>
        )}

        {/* graph */}
        <svg ref={svgRef} className="lk-svg" onMouseDown={onBgDown}
          onMouseDownCapture={(e) => { if (!(e.target as Element).closest(".lk-node")) svgRef.current?.classList.add("panning"); }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#b9c2cf" />
            </marker>
          </defs>
          {ready && (
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {/* edges */}
              {edges.map((e, i) => {
                const a = pos[e.s], b = pos[e.t]; if (!a || !b) return null;
                const on = !!(adj && (e.s === activeId || e.t === activeId));
                const dim = !!(adj && !on);
                const ra = nodeR(byId[e.s]), rb = nodeR(byId[e.t]);
                const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
                const ux = dx / len, uy = dy / len;
                const x1 = a.x + ux * ra, y1 = a.y + uy * ra, x2 = b.x - ux * (rb + 4), y2 = b.y - uy * (rb + 4);
                const mx = (x1 + x2) / 2 - uy * len * 0.08, my = (y1 + y2) / 2 + ux * len * 0.08;
                return (
                  <path key={i} d={`M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`} fill="none"
                    stroke={on ? "var(--primary)" : EDGE_HEX[e.type]}
                    strokeWidth={on ? 1.8 : 1.2} strokeOpacity={dim ? 0.18 : on ? 0.9 : 0.7}
                    strokeDasharray={e.type === "redirect" ? "4 3" : "none"}
                    markerEnd="url(#arrow)" />
                );
              })}
              {/* nodes */}
              {flat.map((n) => {
                const p = pos[n.id]; if (!p) return null;
                const r = nodeR(n); const col = nodeColor(n);
                const isSel = selected === n.id;
                const dim = !!(adj && !adj.has(n.id));
                const showLabel = n.depth <= 1 || isSel || hover === n.id || view.k > 1.25;
                return (
                  <g key={n.id} className="lk-node" transform={`translate(${p.x},${p.y})`}
                    opacity={dim ? 0.3 : 1}
                    onMouseDown={(e) => onNodeDown(e, n.id)}
                    onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover((h) => h === n.id ? null : h)}>
                    {isSel && <circle r={r + 5} fill="none" stroke={col} strokeWidth={2} strokeOpacity={0.35} />}
                    <circle r={r} fill={col} fillOpacity={n.status === 200 ? 0.16 : 0.18}
                      stroke={col} strokeWidth={isSel ? 2.6 : 1.8} />
                    {n.issues.includes("orphan") && <circle r={r} fill="none" stroke={col} strokeWidth={1.4} strokeDasharray="3 2.5" />}
                    {showLabel && (
                      <text x={0} y={r + 13} textAnchor="middle"
                        fontSize={11} fontWeight={n.depth <= 1 ? 600 : 500}
                        fill={isSel ? "var(--primary)" : "var(--text-2)"} style={{ fontSize: 11 }}>
                        {(n.h1 || n.title || lastSeg(n.url)).slice(0, 18)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          )}
        </svg>

        {/* zoom controls */}
        <div className="lk-zoom">
          <button className="btn icon" onClick={() => zoomBy(1.25)}><Icon.plus size={15} /></button>
          <button className="btn icon" onClick={() => zoomBy(0.8)}><span style={{ width: 11, height: 2, background: "currentColor", borderRadius: 2 }} /></button>
        </div>

        {/* legend */}
        <div className="lk-legend">
          <div className="lg-h">凡例</div>
          <div className="lg-row"><span className="sw" style={{ background: STATUS_HEX.ok }} />正常 (2xx)</div>
          <div className="lg-row"><span className="sw" style={{ background: STATUS_HEX.info }} />リダイレクト</div>
          <div className="lg-row"><span className="sw" style={{ background: STATUS_HEX.err }} />エラー (4xx/5xx)</div>
          <div className="lg-row"><span className="sw" style={{ border: "1.4px dashed " + STATUS_HEX.warn, boxSizing: "border-box", background: "transparent" }} />孤立ページ</div>
          <div className="lg-row" style={{ marginTop: 5, color: "var(--text-3)" }}>○ 大きさ = 被リンク数</div>
        </div>
      </div>

      {/* right: detail */}
      <div className="lk-detail-pane">
        {selNode
          ? <DetailPanel node={selNode} mode="stacked" allFlat={flat} onSelect={setSelected} host={host} crawlId={site?.crawl.id ?? ""} startUrl={site?.crawl.startUrl ?? ""} />
          : (
            <div className="lk-empty">
              <Icon.links size={30} style={{ color: "var(--text-3)" }} />
              <div className="ttl">リンク構造グラフ</div>
              <div className="pane-sub" style={{ lineHeight: 1.6 }}>
                ノード＝ページ、エッジ＝内部リンク。ノードをクリックで詳細を表示。<br />
                ドラッグで移動 / ホイールでズーム / 背景ドラッグでパン。
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
