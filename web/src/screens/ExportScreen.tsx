/* ============================================================
   Export — まとめて Excel / 個別 CSV
   サイトマップは「テーブル形式」と「ツリー形式」を分けて出力
   Ported from export.jsx — generation now happens server-side
   (backend /export.xlsx and /export/:dataset.csv); this screen
   drives those endpoints instead of building workbooks client-side.
   ============================================================ */
import React from "react";
import { Icon } from "../components/icons";
import { useSite } from "../lib/SiteContext";
import { api } from "../lib/api";
import type { SiteData } from "../lib/types";

interface DatasetMeta {
  key: string;
  name: string;
  sheet: string;
  desc: string;
  icon: string;
  count: number;
}

function buildDatasetMeta(site: SiteData): DatasetMeta[] {
  const { flat, edges } = site;
  return [
    {
      key: "sitemap-table", name: "サイトマップ（テーブル形式）", sheet: "サイトマップ表",
      desc: "全URLをフラットな表で出力。親URL・子ページ数・階層付き。", icon: "sitemap",
      count: flat.length,
    },
    {
      key: "sitemap-tree", name: "サイトマップ（ツリー形式）", sheet: "サイトマップ階層",
      desc: "サイト構造を階層インデントで再現。プレゼン・監査資料向け。", icon: "layers",
      count: flat.length,
    },
    {
      key: "pages", name: "ページ一覧", sheet: "ページ",
      desc: "Screaming Frog 形式の全ページ詳細（タイトル/H1/正規URL 等）。", icon: "pages",
      count: flat.length,
    },
    {
      key: "links", name: "リンク（内部リンク一覧）", sheet: "リンク",
      desc: "ノード間の全エッジ。リンク元・先・種別・各ステータス。", icon: "links",
      count: edges.length,
    },
    {
      key: "errors", name: "エラー", sheet: "エラー",
      desc: "4xx / 5xx を返すページ。被リンク数で優先度判断。", icon: "errors",
      count: flat.filter((n) => [404, 410, 500].includes(n.status)).length,
    },
    {
      key: "redirects", name: "リダイレクト", sheet: "リダイレクト",
      desc: "3xx の転送元・転送先とチェーン深さ。", icon: "redirects",
      count: flat.filter((n) => [301, 302].includes(n.status)).length,
    },
    {
      key: "orphans", name: "孤立ページ", sheet: "孤立ページ",
      desc: "内部リンクが向いていないページと、その理由・階層。", icon: "sitemap",
      count: flat.filter((n) => n.issues.includes("orphan")).length,
    },
  ];
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ExportScreen() {
  const { site } = useSite();
  const datasets = React.useMemo(() => site ? buildDatasetMeta(site) : [], [site]);
  const [mode, setMode] = React.useState<"excel" | "csv">("excel");
  const [sel, setSel] = React.useState<Set<string>>(() => new Set());
  const [done, setDone] = React.useState<string | null>(null);
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setSel(new Set(datasets.map((d) => d.key)));
  }, [datasets]);

  if (!site) {
    return <div className="ex-wrap"><div className="pane-sub" style={{ padding: 40 }}>クロールデータを読み込み中…</div></div>;
  }

  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOn = sel.size === datasets.length;
  const chosen = datasets.filter((d) => sel.has(d.key));

  const flash = (msg: string) => {
    setDone(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setDone(null), 2200);
  };

  const exportCSVFile = (ds: DatasetMeta) => {
    triggerDownload(api.exportCsvUrl(site.crawl.id, ds.key));
  };

  const doExcel = () => {
    if (!chosen.length) return;
    triggerDownload(api.exportXlsxUrl(site.crawl.id, chosen.map((d) => d.key)));
    flash(`Excel を書き出しました（${chosen.length} シート）`);
  };
  const doAllCSV = () => {
    chosen.forEach((d, i) => setTimeout(() => exportCSVFile(d), i * 250));
    flash(`${chosen.length} 件の CSV を書き出しました`);
  };

  return (
    <div className="ex-wrap">
      <div className="ex-inner">
        <div className="ex-head">
          <div>
            <h1 className="ex-title">エクスポート</h1>
            <p className="ex-sub">クロール結果（{site.host} ・ {site.counts.pages} URL）を出力します。</p>
          </div>
        </div>

        {/* mode toggle */}
        <div className="ex-modes">
          <button className={"ex-mode" + (mode === "excel" ? " on" : "")} onClick={() => setMode("excel")}>
            <div className="ex-mode-ic" style={{ background: "var(--ok-weak)", color: "#15803d" }}><Icon.export size={18} /></div>
            <div className="ex-mode-tx">
              <b>まとめて Excel</b>
              <span>選択したデータを1つの .xlsx に複数シートで出力</span>
            </div>
            <span className="ex-radio">{mode === "excel" && <span />}</span>
          </button>
          <button className={"ex-mode" + (mode === "csv" ? " on" : "")} onClick={() => setMode("csv")}>
            <div className="ex-mode-ic" style={{ background: "var(--primary-weak)", color: "var(--primary)" }}><Icon.file size={18} /></div>
            <div className="ex-mode-tx">
              <b>個別 CSV</b>
              <span>データセットごとに個別の .csv をダウンロード</span>
            </div>
            <span className="ex-radio">{mode === "csv" && <span />}</span>
          </button>
        </div>

        {/* dataset list */}
        <div className="ex-list-head">
          <span className="ex-lh-title">出力対象</span>
          <button className="btn ghost sm" onClick={() => setSel(allOn ? new Set() : new Set(datasets.map((d) => d.key)))}>
            <span className={"cbx" + (allOn ? " on" : "")} style={{ width: 14, height: 14 }}>{allOn && <Icon.check size={10} />}</span>
            すべて選択
          </button>
        </div>

        <div className="ex-list">
          {datasets.map((ds) => {
            const on = sel.has(ds.key);
            const Ico = Icon[ds.icon];
            return (
              <div key={ds.key} className={"ex-item" + (on ? " on" : "")} onClick={() => mode === "excel" && toggle(ds.key)}>
                {mode === "excel" && (
                  <button className={"cbx" + (on ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggle(ds.key); }}>{on && <Icon.check size={11} />}</button>
                )}
                <div className="ex-item-ic"><Ico size={18} /></div>
                <div className="ex-item-tx">
                  <div className="ex-item-name">{ds.name} <span className="ex-count">{ds.count} 行</span></div>
                  <div className="ex-item-desc">{ds.desc}</div>
                </div>
                {mode === "excel"
                  ? <span className="ex-sheet mono">シート: {ds.sheet}</span>
                  : <button className="btn sm" onClick={(e) => { e.stopPropagation(); exportCSVFile(ds); flash(`${ds.name} を CSV 出力しました`); }}><Icon.export size={13} /> CSV</button>}
              </div>
            );
          })}
        </div>

        {/* action bar */}
        <div className="ex-actions">
          <div className="ex-act-info">
            {done
              ? <span className="ex-flash"><Icon.check size={15} /> {done}</span>
              : <span className="pane-sub">{chosen.length} 件のデータセットを選択中</span>}
          </div>
          {mode === "excel"
            ? <button className="btn primary" disabled={!chosen.length} onClick={doExcel}><Icon.export size={15} /> Excel をダウンロード（{chosen.length} シート）</button>
            : <button className="btn primary" disabled={!chosen.length} onClick={doAllCSV}><Icon.export size={15} /> 選択をまとめて個別DL（{chosen.length} 件）</button>}
        </div>
      </div>
    </div>
  );
}
