/* ============================================================
   Sitemap screen — site tree (left) + fixed detail panel (right)
   Ported from sitemap.jsx (window.SITE → useSite() context)
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { statusOf, lastSeg, ISSUE_META, ISSUE_HINT, buildPathTree } from "../lib/common";
import { useSite } from "../lib/SiteContext";
import { api } from "../lib/api";
import type { PageNode, PageTreeNode } from "../lib/types";

function StatusBadge({ node, showOk }: { node: PageNode; showOk?: boolean }) {
  const m = statusOf(node);
  if (node.status === 200 && !showOk) return null;
  return <span className={"badge " + m.cls}>{m.label}</span>;
}

/* ---------- TREE ---------- */
interface TreeRowProps {
  node: PageTreeNode;
  depth: number;
  mode: "title" | "path";
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  hasKids: boolean;
}

function TreeRow({ node, depth, mode, expanded, onToggle, selected, onSelect, hasKids }: TreeRowProps) {
  const m = statusOf(node);
  const isSel = selected === node.id;
  const open = expanded.has(node.id);
  const primary = mode === "path" ? lastSeg(node.url) : (node.h1 || node.title);
  const secondary = mode === "path" ? (node.h1 || node.title) : node.url;
  const nonStatusIssues = node.issues.filter((i) => !["broken", "redirect"].includes(i));

  return (
    <div
      className={"tree-row" + (isSel ? " sel" : "")}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => onSelect(node.id)}
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span key={i} className="guide" style={{ left: 14 + i * 16 }} />
      ))}

      <button
        className={"twisty" + (hasKids ? "" : " leaf")}
        onClick={(e) => { e.stopPropagation(); if (hasKids) onToggle(node.id); }}
      >
        {hasKids && <Icon.chevron size={13} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />}
      </button>

      <span className={"node-ico " + m.dot}>
        {hasKids ? <Icon.folder size={15} /> : <Icon.file size={14} />}
      </span>

      <span className={"node-label" + (mode === "path" ? " mono" : "")} title={secondary}>
        {primary}
      </span>

      <span className="tree-meta">
        {nonStatusIssues.map((iss) => (
          <span key={iss} className={"badge " + ISSUE_META[iss].cls} style={{ height: 17, fontSize: 10, padding: "0 6px" }}>
            {ISSUE_META[iss].short}
          </span>
        ))}
        <StatusBadge node={node} />
        {node.status === 200 && <span className={"dot-s " + m.dot} style={{ marginLeft: 2 }} />}
      </span>
    </div>
  );
}

interface TreeProps {
  root: PageTreeNode;
  mode: "title" | "path";
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  visibleIds: Set<string> | null;
}

function Tree({ root, mode, expanded, onToggle, selected, onSelect, visibleIds }: TreeProps) {
  const rows: React.ReactElement[] = [];
  // インデント幅はツリー上の実際の階層（再帰の深さ）で決める。
  // node.depth はクロール時のリンク距離（detailパネルの「階層」表示用）であり、
  // URLディレクトリツリーなど親子関係が異なるツリーでは表示位置と一致しないため。
  const walk = (node: PageTreeNode, level: number) => {
    if (visibleIds && !visibleIds.has(node.id)) return;
    const kids = (node.children || []).filter((c) => !visibleIds || visibleIds.has(c.id));
    rows.push(
      <TreeRow
        key={node.id} node={node} depth={level} mode={mode}
        expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect}
        hasKids={(node.children || []).length > 0}
      />
    );
    if (expanded.has(node.id)) kids.forEach((k) => walk(k, level + 1));
  };
  walk(root, 0);
  return <div className="tree">{rows}</div>;
}

/* ---------- DETAIL PANEL ---------- */
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-v tnum">{value}</div>
      <div className="stat-l">{label}{sub && <span className="stat-sub"> {sub}</span>}</div>
    </div>
  );
}
function KV({ k, children, mono, clip }: { k: string; children?: React.ReactNode; mono?: boolean; clip?: boolean }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className={"kv-v" + (mono ? " mono" : "") + (clip ? " clip" : "")}>{children}</div>
    </div>
  );
}
function Section({ title, right, children }: { title: string; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="dp-section">
      <div className="dp-sec-head">
        <span>{title}</span>{right}
      </div>
      {children}
    </div>
  );
}

export interface DetailPanelProps {
  node: PageNode | null | undefined;
  mode: "stacked" | "compact";
  allFlat: PageNode[];
  onSelect: (id: string) => void;
  host: string;
  crawlId: string;
}

export function DetailPanel({ node, mode, allFlat, onSelect, host, crawlId }: DetailPanelProps) {
  const [linkedFrom, setLinkedFrom] = React.useState<{ url: string; title: string; status: number }[]>([]);

  React.useEffect(() => {
    if (!node) { setLinkedFrom([]); return; }
    let live = true;
    api.page(crawlId, node.id).then((d) => { if (live) setLinkedFrom(d.linkedFrom); }).catch(() => { if (live) setLinkedFrom([]); });
    return () => { live = false; };
  }, [crawlId, node]);

  if (!node) return (
    <div className="detail empty">
      <Icon.pages size={28} style={{ color: "var(--text-3)" }} />
      <div>ツリーからページを選択</div>
      <div className="pane-sub">詳細・インデックス可否・リンク関係がここに表示されます。</div>
    </div>
  );

  const m = statusOf(node);
  const indexable = node.status === 200 && !node.noindex;

  const meta = (
    <>
      <KV k="ステータス">
        <span className={"badge " + m.cls}>{m.label}</span>
        <span style={{ color: "var(--text-3)", marginLeft: 8, fontSize: 12 }}>
          {node.status === 200 ? "正常" : node.status === 404 ? "未検出" : node.status === 410 ? "削除済" : node.status === 500 ? "サーバーエラー" : node.status >= 300 ? "リダイレクト" : ""}
        </span>
      </KV>
      <KV k="インデックス">
        {indexable
          ? <span className="badge ok"><span className="dot" style={{ background: "var(--ok)" }} />インデックス可</span>
          : <span className="badge violet"><span className="dot" style={{ background: "var(--violet)" }} />インデックス不可</span>}
      </KV>
      <KV k="正規URL" mono clip>
        {node.canonical === "self" ? <span style={{ color: "var(--text-2)" }}>自身 ↩</span> : node.canonical}
      </KV>
      <KV k="Robots">{node.noindex ? <span style={{ color: "var(--violet)" }}>noindex, follow</span> : <span style={{ color: "var(--text-2)" }}>index, follow</span>}</KV>
      <KV k="階層">{node.depth} {node.depth === 0 ? "(ルート)" : "クリック"}</KV>
      {node.redirectTo && <KV k="リダイレクト先" mono clip><span style={{ color: "var(--info)" }}>{node.redirectTo}</span></KV>}
    </>
  );

  return (
    <div className="detail">
      <div className="dp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={"dot-s " + m.dot} style={{ width: 9, height: 9 }} />
          <span className="dp-crumb mono">{node.url === "/" ? "ホーム" : node.url.split("/").filter(Boolean).map((s, i, a) => i === a.length - 1 ? s : s + " /").join(" ")}</span>
        </div>
        <h2 className="dp-title">{node.h1 || node.title || lastSeg(node.url)}</h2>
        <div className="dp-url mono">
          <span>{host}{node.url}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost icon sm" title="URLをコピー"><Icon.copy size={14} /></button>
          <button className="btn ghost icon sm" title="開く"><Icon.external size={14} /></button>
        </div>
      </div>

      <div className="dp-stats">
        <Stat label="被リンク" value={node.inLinks} />
        <Stat label="発リンク" value={node.outLinks} />
        <Stat label="単語数" value={node.words.toLocaleString()} />
        <Stat label="サイズ" value={node.size} sub="KB" />
      </div>

      <div className="dp-body">
        {node.issues.length > 0 && (
          <Section title={`問題 · ${node.issues.length}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {node.issues.map((iss) => {
                const im = ISSUE_META[iss];
                return (
                  <div key={iss} className="issue-line">
                    <span className={"dot-s " + im.cls} />
                    <span className="issue-name">{im.label}</span>
                    <span className="issue-hint">{ISSUE_HINT[iss]}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        <Section title="ページ情報">
          {mode === "compact"
            ? <div className="kv-grid">{meta}</div>
            : <div className="kv-stack">{meta}</div>}
        </Section>

        <Section title="タイトル">
          <div className="seo-field">
            <div className="seo-val">{node.title || <span style={{ color: "var(--text-3)" }}>— 未設定 —</span>}</div>
            <div className="seo-meta">{node.title ? node.title.length : 0} 文字 · {node.issues.includes("dup-title") ? <span style={{ color: "var(--warn)" }}>他ページと重複</span> : "一意"}</div>
          </div>
          <div className="seo-field" style={{ marginTop: 8 }}>
            <div className="seo-lbl">H1</div>
            <div className="seo-val">{node.h1 || <span style={{ color: "var(--text-3)" }}>— なし —</span>}</div>
          </div>
        </Section>

        <Section title="内部リンク" right={<span className="pane-sub">{node.inLinks} 被 · {node.outLinks} 発</span>}>
          <div className="link-sub">被リンク元</div>
          {linkedFrom.length ? linkedFrom.map((p) => {
            const target = allFlat.find((f) => f.url === p.url);
            return (
              <button key={p.url} className="link-row" onClick={() => target && onSelect(target.id)}>
                <span className={"dot-s " + statusOf(p).dot} />
                <span className="link-title">{p.title}</span>
                <span className="link-url mono">{p.url}</span>
                <Icon.arrowRight size={13} style={{ color: "var(--text-3)" }} />
              </button>
            );
          }) : <div className="pane-sub" style={{ padding: "6px 2px" }}>被リンクがありません — このページは孤立しています。</div>}
        </Section>
      </div>
    </div>
  );
}

export interface SitemapScreenProps {
  treeMode: "title" | "path";
  treeBasis: "link" | "path";
  detailMode: "stacked" | "compact";
}

export function SitemapScreen({ treeMode, treeBasis, detailMode }: SitemapScreenProps) {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  // 「リンク構造」= クロールで発見した経路をそのまま親子関係とするツリー（site.tree）
  // 「URLディレクトリ」= URLパスの上位セグメントに対応する既存ページを親とみなすツリー
  // （HTMLサイトマップ等の「全ページへのリンク集」が他ページの親に見えてしまう問題を避けたい場合に使う）
  const pathTree = React.useMemo(() => (treeBasis === "path" ? buildPathTree(flat) : null), [treeBasis, flat]);
  const TREE = treeBasis === "path" ? pathTree : site?.tree ?? null;
  const host = site?.host ?? "";
  const counts = site?.counts ?? { pages: 0, ok: 0, errors: 0, redirects: 0, orphans: 0, noindex: 0, dupTitles: 0 };

  const parentMap = React.useMemo(() => {
    const m: Record<string, string> = {};
    const walk = (n: PageTreeNode) => (n.children || []).forEach((c) => { m[c.id] = n.id; walk(c); });
    if (TREE) walk(TREE);
    return m;
  }, [TREE]);
  const ancestorsOf = React.useCallback((id: string) => {
    const out: string[] = []; let cur = parentMap[id]; while (cur) { out.push(cur); cur = parentMap[cur]; } return out;
  }, [parentMap]);

  const [selected, setSelected] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set<string>());
  const initedRef = React.useRef(false);

  // initialize selection/expansion once tree data arrives
  React.useEffect(() => {
    if (initedRef.current || !TREE || !flat.length) return;
    initedRef.current = true;
    const firstIssue = flat.find((n) => n.issues.length > 0) || flat[0];
    setSelected(firstIssue.id);
    setExpanded(new Set([
      ...flat.filter((n) => n.depth < 1 && (n as PageTreeNode).children?.length).map((n) => n.id),
      TREE.id,
      ...ancestorsOf(firstIssue.id),
    ]));
  }, [TREE, flat, ancestorsOf]);

  const selectAndReveal = React.useCallback((id: string) => {
    setSelected(id);
    setExpanded((s) => { const n = new Set(s); ancestorsOf(id).forEach((a) => n.add(a)); return n; });
  }, [ancestorsOf]);

  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll = () => setExpanded(new Set(flat.map((n) => n.id)));
  const collapseAll = () => TREE && setExpanded(new Set([TREE.id]));

  const FILTERS = [
    { id: "all", label: "すべて", n: flat.length },
    { id: "issues", label: "問題", n: flat.filter((n) => n.issues.length).length },
    { id: "errors", label: "エラー", n: counts.errors },
    { id: "redirects", label: "リダイレクト", n: counts.redirects },
    { id: "orphans", label: "孤立", n: counts.orphans },
    { id: "noindex", label: "Noindex", n: counts.noindex },
  ];

  const matchPred = (n: PageNode) => {
    const q = query.trim().toLowerCase();
    if (q && !((n.url + " " + n.title + " " + n.h1).toLowerCase().includes(q))) return false;
    if (filter === "issues") return n.issues.length > 0;
    if (filter === "errors") return [404, 410, 500].includes(n.status);
    if (filter === "redirects") return [301, 302].includes(n.status);
    if (filter === "orphans") return n.issues.includes("orphan");
    if (filter === "noindex") return n.noindex;
    return true;
  };

  const filtering = !!query.trim() || filter !== "all";
  let visibleIds: Set<string> | null = null;
  if (filtering) {
    visibleIds = new Set<string>();
    const parentOf: Record<string, string> = {};
    const walk = (n: PageTreeNode) => (n.children || []).forEach((c) => { parentOf[c.id] = n.id; walk(c); });
    if (TREE) walk(TREE);
    flat.filter(matchPred).forEach((n) => {
      let cur: string | undefined = n.id;
      while (cur) { visibleIds!.add(cur); cur = parentOf[cur]; }
    });
  }
  const effExpanded = filtering ? new Set(flat.map((n) => n.id)) : expanded;

  const selNode = flat.find((n) => n.id === selected);
  const matchCount = flat.filter(matchPred).length;

  if (!TREE) {
    return <div className="sm-layout"><div className="pane-sub" style={{ padding: 40 }}>クロールデータを読み込み中…</div></div>;
  }

  return (
    <div className="sm-layout">
      <div className="sm-tree-pane">
        <div className="pane-head">
          <Icon.layers size={16} style={{ color: "var(--primary)" }} />
          <span className="pane-title">サイト構造</span>
          <span className="badge muted">{matchCount}{filtering && ` / ${flat.length}`}</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost icon sm" title="すべて展開" onClick={expandAll}><Icon.expand size={15} /></button>
          <button className="btn ghost icon sm" title="すべて折りたたむ" onClick={collapseAll}><Icon.expand size={15} style={{ transform: "rotate(180deg)" }} /></button>
        </div>

        <div className="sm-toolbar">
          <div className="search" style={{ flex: 1, minWidth: 0 }}>
            <Icon.search size={14} />
            <input placeholder="URL・タイトルで絞り込み…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <button className="btn ghost icon" style={{ width: 18, height: 18 }} onClick={() => setQuery("")}><Icon.close size={12} /></button>}
          </div>
        </div>
        <div className="sm-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={"chip sm" + (filter === f.id ? " active" : "")} style={{ height: 24, fontSize: 11.5 }} onClick={() => setFilter(f.id)}>
              {f.label} <span className="n">{f.n}</span>
            </button>
          ))}
        </div>

        <div className="sm-tree-scroll">
          <Tree
            root={TREE} mode={treeMode} expanded={effExpanded} onToggle={toggle}
            selected={selected} onSelect={selectAndReveal} visibleIds={visibleIds}
          />
          {filtering && matchCount === 0 && (
            <div className="pane-sub" style={{ padding: 24, textAlign: "center" }}>該当するページがありません。</div>
          )}
        </div>
      </div>

      <div className="sm-detail-pane">
        <DetailPanel node={selNode} mode={detailMode} allFlat={flat} onSelect={selectAndReveal} host={host} crawlId={site?.crawl.id ?? ""} />
      </div>
    </div>
  );
}
