/* ============================================================
   SimpleTable — generic sortable table (reuses table.pg styling)
   shared by Errors / Orphans screens
   Ported from issuelists.jsx
   ============================================================ */
import React from "react";
import { Icon } from "./icons";
import type { PageNode } from "../lib/types";

export interface SimpleCol {
  key: string;
  label: string;
  w: number;
  align?: "left" | "right" | "center";
  num?: boolean;
  sort?: (n: PageNode) => string | number;
  render: (n: PageNode) => React.ReactNode;
}

export function impactOf(n: PageNode) {
  if (n.inLinks >= 10) return { cls: "high", label: "高" };
  if (n.inLinks >= 3) return { cls: "mid", label: "中" };
  return { cls: "low", label: "低" };
}

export function SimpleTable({ cols, rows, empty }: { cols: SimpleCol[]; rows: PageNode[]; empty: React.ReactNode }) {
  const [sortKey, setSortKey] = React.useState<string | null>(null);
  const [dir, setDir] = React.useState<"asc" | "desc">("asc");
  let data = rows;
  if (sortKey) {
    const col = cols.find((c) => c.key === sortKey)!;
    data = [...rows].sort((a, b) => {
      const av = col.sort!(a), bv = col.sort!(b);
      const c = typeof av === "string" ? av.localeCompare(bv as string, "ja") : (av as number) - (bv as number);
      return dir === "asc" ? c : -c;
    });
  }
  const click = (c: SimpleCol) => {
    if (!c.sort) return;
    if (sortKey === c.key) setDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(c.key); setDir(c.num ? "desc" : "asc"); }
  };
  return (
    <div className="pg-scroll">
      <table className="pg">
        <colgroup>{cols.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
        <thead><tr>
          {cols.map((c) => (
            <th key={c.key} style={{ textAlign: c.align || "left", cursor: c.sort ? "pointer" : "default" }} onClick={() => click(c)}>
              <span className="th-in" style={{ justifyContent: c.align === "right" ? "flex-end" : c.align === "center" ? "center" : "flex-start" }}>
                {c.label}
                {c.sort && <span className={"sort-arrow" + (sortKey === c.key ? "" : " muted")}>{sortKey === c.key && dir === "asc" ? <Icon.chevronDown size={12} style={{ transform: "rotate(180deg)" }} /> : <Icon.chevronDown size={12} />}</span>}
              </span>
            </th>
          ))}
        </tr></thead>
        <tbody>
          {data.map((n, i) => (
            <tr key={n.id || i}>
              {cols.map((c) => <td key={c.key} style={{ textAlign: c.align || "left" }}>{c.render(n)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length === 0 && empty}
    </div>
  );
}
