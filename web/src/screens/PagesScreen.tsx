/* ============================================================
   Pages — 高密度データテーブル（検索/ソート/フィルタ/列固定/CSV）
   Ported from pages.jsx (window.SITE → useSite() context)
   Row state (sort/visibility/selection) backed by @tanstack/react-table;
   body rows virtualized with @tanstack/react-virtual for large sites.
   ============================================================ */
import React from "react";
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  type ColumnDef, type SortingState, type VisibilityState, type RowSelectionState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../components/icons";
import { statusOf, ISSUE_META, downloadFile } from "../lib/common";
import { useSite } from "../lib/SiteContext";
import type { PageNode } from "../lib/types";

interface PgCol {
  key: string;
  label?: string;
  w: number;
  frozen?: boolean;
  shadow?: boolean;
  sortable?: boolean;
  num?: boolean;
  center?: boolean;
  optional?: boolean;
}

const PG_COLS: PgCol[] = [
  { key: "check", w: 42, frozen: true, sortable: false },
  { key: "status", label: "ステータス", w: 96, frozen: true, sortable: true, num: true },
  { key: "url", label: "URL", w: 330, frozen: true, shadow: true, sortable: true },
  { key: "title", label: "タイトル", w: 256, sortable: true },
  { key: "h1", label: "H1", w: 196, sortable: true, optional: true },
  { key: "depth", label: "階層", w: 64, center: true, num: true, sortable: true },
  { key: "inLinks", label: "被リンク", w: 84, num: true, sortable: true, optional: true },
  { key: "words", label: "単語数", w: 84, num: true, sortable: true, optional: true },
  { key: "canonical", label: "正規URL", w: 140, optional: true, sortable: false },
  { key: "noindex", label: "Index", w: 92, center: true, sortable: true },
  { key: "issues", label: "問題", w: 220, sortable: false },
];
const PG_OPTIONAL = PG_COLS.filter((c) => c.optional);
const ROW_H = 30;

function Cbx({ on, mixed, onClick }: { on: boolean; mixed?: boolean; onClick: () => void }) {
  return (
    <button className={"cbx" + (on ? " on" : "") + (mixed ? " mixed" : "")} onClick={onClick}>
      {mixed ? <span style={{ width: 8, height: 2, background: "#fff", borderRadius: 2 }} /> : on ? <Icon.check size={11} /> : null}
    </button>
  );
}

function sortVal(n: PageNode, key: string): string | number {
  switch (key) {
    case "status": return n.status;
    case "url": return n.url;
    case "title": return n.title || "";
    case "h1": return n.h1 || "";
    case "depth": return n.depth;
    case "inLinks": return n.inLinks;
    case "words": return n.words;
    case "noindex": return n.noindex ? 1 : 0;
    default: return 0;
  }
}

function downloadCSV(rows: PageNode[], host: string) {
  const cols: [string, (n: PageNode) => string | number][] = [
    ["URL", (n) => n.url],
    ["ステータス", (n) => n.status],
    ["タイトル", (n) => n.title],
    ["H1", (n) => n.h1],
    ["階層", (n) => n.depth],
    ["正規URL", (n) => n.canonical === "self" ? n.url : n.canonical],
    ["Noindex", (n) => n.noindex ? "noindex" : "index"],
    ["被リンク", (n) => n.inLinks],
    ["単語数", (n) => n.words],
    ["問題", (n) => n.issues.map((i) => ISSUE_META[i].label).join(" / ")],
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map((c) => c[0]).join(",")];
  rows.forEach((n) => lines.push(cols.map((c) => esc(c[1](n))).join(",")));
  downloadFile(`pages_${host}.csv`, "﻿" + lines.join("\r\n"));
}

function PgCell({ col, node }: { col: PgCol; node: PageNode }) {
  switch (col.key) {
    case "status": {
      const m = statusOf(node);
      return <span className={"badge " + m.cls} title={m.jp}>{m.label}</span>;
    }
    case "url": {
      const segs = node.url === "/" ? "/" : node.url;
      return <span className="c-url" title={node.url}>{segs}</span>;
    }
    case "title":
      return node.title ? <>{node.title}</> : <span className="c-muted">— 未設定 —</span>;
    case "h1":
      return node.h1 ? <span style={{ color: "var(--text-2)" }}>{node.h1}</span> : <span className="c-muted">—</span>;
    case "depth":
      return <span className="c-num" style={{ display: "block" }}>{node.depth}</span>;
    case "inLinks":
      return <span className="c-num" style={{ display: "block", color: node.inLinks === 0 ? "var(--err)" : "var(--text-2)" }}>{node.inLinks}</span>;
    case "words":
      return <span className="c-num" style={{ display: "block" }}>{node.words ? node.words.toLocaleString() : <span className="c-muted">0</span>}</span>;
    case "canonical":
      return <span className="c-url c-muted" title={node.canonical === "self" ? node.url : node.canonical}>{node.canonical === "self" ? "自身" : node.canonical}</span>;
    case "noindex":
      return node.noindex
        ? <span className="badge violet" style={{ margin: "0 auto" }}>Noindex</span>
        : <span className="c-muted" style={{ display: "block", textAlign: "center" }}>index</span>;
    case "issues":
      return node.issues.length
        ? <span className="issue-cell">{node.issues.map((i) => <span key={i} className={"badge " + ISSUE_META[i].cls} style={{ height: 18 }}>{ISSUE_META[i].label}</span>)}</span>
        : <span className="c-muted">—</span>;
    default: return null;
  }
}

export function PagesScreen() {
  const { site } = useSite();
  const flat = site?.flat ?? [];
  const host = site?.host ?? "";

  const [tab, setTab] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [colMenu, setColMenu] = React.useState(false);

  const TABS = [
    { id: "all", label: "すべて", n: flat.length, pip: null as string | null },
    { id: "ok", label: "正常 2xx", n: flat.filter((n) => n.status === 200).length, pip: "var(--ok)" },
    { id: "redirect", label: "リダイレクト 3xx", n: flat.filter((n) => [301, 302].includes(n.status)).length, pip: "var(--info)" },
    { id: "error", label: "エラー 4xx・5xx", n: flat.filter((n) => [404, 410, 500].includes(n.status)).length, pip: "var(--err)" },
    { id: "noindex", label: "Noindex", n: flat.filter((n) => n.noindex).length, pip: "var(--violet)" },
    { id: "issues", label: "問題あり", n: flat.filter((n) => n.issues.length).length, pip: "var(--warn)" },
  ];

  const pred = React.useCallback((n: PageNode) => {
    const q = query.trim().toLowerCase();
    if (q && !((n.url + " " + n.title + " " + n.h1).toLowerCase().includes(q))) return false;
    if (tab === "ok") return n.status === 200;
    if (tab === "redirect") return [301, 302].includes(n.status);
    if (tab === "error") return [404, 410, 500].includes(n.status);
    if (tab === "noindex") return n.noindex;
    if (tab === "issues") return n.issues.length > 0;
    return true;
  }, [query, tab]);

  const filtered = React.useMemo(() => flat.filter(pred), [flat, pred]);

  /* ---- TanStack Table: drives sorting / column visibility / row selection state ---- */
  const columns = React.useMemo<ColumnDef<PageNode>[]>(() => PG_COLS.map((c) => ({
    id: c.key,
    accessorFn: (row) => sortVal(row, c.key),
    enableSorting: !!c.sortable,
    sortingFn: (a, b) => {
      const av = sortVal(a.original, c.key), bv = sortVal(b.original, c.key);
      return typeof av === "string" ? av.localeCompare(bv as string, "ja") : (av as number) - (bv as number);
    },
  })), []);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnVisibility, rowSelection },
    getRowId: (row) => row.id,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const sortKey = sorting[0]?.id ?? null;
  const sortDir = sorting[0] ? (sorting[0].desc ? "desc" : "asc") : "asc";

  const cols = PG_COLS.filter((c) => table.getColumn(c.key)?.getIsVisible() ?? true);
  let acc = 0; const leftOf: Record<string, number> = {};
  cols.forEach((c) => { if (c.frozen) { leftOf[c.key] = acc; acc += c.w; } });

  const clickSort = (c: PgCol) => {
    if (!c.sortable) return;
    if (sortKey === c.key) setSorting([{ id: c.key, desc: sortDir === "asc" }]);
    else setSorting([{ id: c.key, desc: !!c.num }]);
  };

  const selected = rowSelection;
  const selCount = Object.keys(selected).filter((k) => selected[k]).length;
  const allSel = rows.length > 0 && rows.every((r) => selected[r.id]);
  const someSel = rows.some((r) => selected[r.id]);
  const toggleAll = () => {
    if (allSel) {
      const next = { ...selected };
      rows.forEach((r) => { delete next[r.id]; });
      setRowSelection(next);
    } else {
      const next = { ...selected };
      rows.forEach((r) => { next[r.id] = true; });
      setRowSelection(next);
    }
  };
  const toggleOne = (id: string) => setRowSelection((s) => {
    const n = { ...s };
    if (n[id]) delete n[id]; else n[id] = true;
    return n;
  });

  const exportRows = selCount ? rows.filter((r) => selected[r.id]).map((r) => r.original) : rows.map((r) => r.original);

  /* ---- virtualization ---- */
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const padTop = virtualRows.length ? virtualRows[0].start : 0;
  const padBottom = virtualRows.length ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0;

  return (
    <div className="pg-wrap">
      {/* toolbar */}
      <div className="pg-toolbar">
        <div className="search" style={{ width: 280 }}>
          <Icon.search size={15} />
          <input placeholder="URL・タイトル・H1 を検索…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="btn ghost icon" style={{ width: 18, height: 18 }} onClick={() => setQuery("")}><Icon.close size={12} /></button>}
        </div>
        <div style={{ flex: 1 }} />
        {sortKey && (
          <button className="btn ghost sm" onClick={() => setSorting([])}>
            <Icon.sort size={14} /> 並び替えを解除
          </button>
        )}
        <div style={{ position: "relative" }}>
          <button className="btn sm" onClick={() => setColMenu((v) => !v)}>
            <Icon.columns size={14} /> 列 {Object.keys(columnVisibility).some((k) => columnVisibility[k] === false) && <span className="badge muted" style={{ height: 16 }}>{cols.length}</span>}
          </button>
          {colMenu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setColMenu(false)} />
              <div className="colmenu">
                <div className="colmenu-h">表示する列</div>
                {PG_OPTIONAL.map((c) => {
                  const on = table.getColumn(c.key)?.getIsVisible() ?? true;
                  return (
                    <button key={c.key} className="colmenu-item" onClick={() => table.getColumn(c.key)?.toggleVisibility(!on)}>
                      <span className={"cbx" + (on ? " on" : "")}>{on && <Icon.check size={10} />}</span>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <button className="btn primary sm" onClick={() => downloadCSV(exportRows, host)}>
          <Icon.export size={14} /> CSV出力{selCount ? `（${selCount}件）` : ""}
        </button>
      </div>

      {/* status tabs */}
      <div className="pg-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={"pg-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
            {t.pip && <span className="pip" style={{ background: t.pip }} />}
            {t.label}<span className="n">{t.n}</span>
          </button>
        ))}
      </div>

      {/* table */}
      <div className="pg-scroll" ref={scrollRef}>
        <table className="pg">
          <colgroup>{cols.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
          <thead>
            <tr>
              {cols.map((c) => {
                const isSort = sortKey === c.key;
                const style = c.frozen ? { left: leftOf[c.key] } : undefined;
                const cls = (c.frozen ? "frz" : "") + (c.shadow ? " shadow" : "");
                if (c.key === "check") {
                  return <th key="check" className={cls} style={style}><div className="cell-checkbox"><Cbx on={allSel} mixed={!allSel && someSel} onClick={toggleAll} /></div></th>;
                }
                return (
                  <th key={c.key} className={cls} style={{ ...style, textAlign: c.center ? "center" : c.num ? "right" : "left", cursor: c.sortable ? "pointer" : "default" }} onClick={() => clickSort(c)}>
                    <span className="th-in" style={{ justifyContent: c.center ? "center" : c.num ? "flex-end" : "flex-start" }}>
                      {c.label}
                      {c.sortable && (
                        <span className={"sort-arrow" + (isSort ? "" : " muted")}>
                          {isSort && sortDir === "asc" ? <Icon.chevronDown size={12} style={{ transform: "rotate(180deg)" }} /> : <Icon.chevronDown size={12} />}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr><td style={{ height: padTop, padding: 0, border: "none" }} colSpan={cols.length} /></tr>
            )}
            {virtualRows.map((vr) => {
              const node = rows[vr.index].original;
              const isSel = !!selected[node.id];
              return (
                <tr key={node.id} className={isSel ? "sel" : ""}>
                  {cols.map((c) => {
                    const style = c.frozen ? { left: leftOf[c.key] } : undefined;
                    const cls = (c.frozen ? "frz" : "") + (c.shadow ? " shadow" : "");
                    if (c.key === "check") {
                      return <td key="check" className={cls} style={style}><div className="cell-checkbox"><Cbx on={isSel} onClick={() => toggleOne(node.id)} /></div></td>;
                    }
                    return (
                      <td key={c.key} className={cls} style={{ ...style, textAlign: c.center ? "center" : c.num ? "right" : "left" }}>
                        <PgCell col={c} node={node} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr><td style={{ height: padBottom, padding: 0, border: "none" }} colSpan={cols.length} /></tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <div className="pane-sub" style={{ padding: 40, textAlign: "center" }}>該当するページがありません。</div>}
      </div>

      {/* footer */}
      <div className="pg-foot">
        <span><b>{rows.length}</b> 件表示<span className="c-muted"> / 全 {flat.length} 件</span></span>
        <span className="sep" />
        <span><b style={{ color: "var(--ok)" }}>{rows.filter((r) => r.original.status === 200).length}</b> 正常</span>
        <span><b style={{ color: "var(--err)" }}>{rows.filter((r) => [404, 410, 500].includes(r.original.status)).length}</b> エラー</span>
        <span><b style={{ color: "var(--info)" }}>{rows.filter((r) => [301, 302].includes(r.original.status)).length}</b> 転送</span>
        <div style={{ flex: 1 }} />
        {selCount > 0 && <span><b>{selCount}</b> 件選択中</span>}
      </div>
    </div>
  );
}
