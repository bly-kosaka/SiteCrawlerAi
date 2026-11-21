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
import { downloadFile } from "../lib/common";
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
  const { flat, edgeCount } = site;
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
      count: edgeCount,
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

// Content-Disposition からファイル名を取り出す（filename*=UTF-8''… と filename="…" の両方に対応）
function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* 下の filename= にフォールバック */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

// fetch でダウンロードして保存する。
// 以前はリンク遷移でダウンロードしていたため、完了を待てず（まとめて個別DLが同時に走りサーバー側の
// 全件読み込みが重なる）、409/429/503 などのエラー応答もページ遷移になってしまい画面で扱えなかった。
async function fetchDownload(url: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    throw new Error("サーバーに接続できませんでした。通信環境を確認して再実行してください。");
  }
  if (!res.ok) {
    let msg = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") msg = body.error;
    } catch { /* 本文が JSON でない */ }
    if (res.status === 429) throw new Error("エクスポートの要求が短時間に集中しています。少し待ってから再実行してください。");
    if (res.status === 503) throw new Error(msg || "サーバーが混み合っています。少し待ってから再実行してください。");
    throw new Error(msg || `ダウンロードに失敗しました（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  downloadFile(filenameFrom(res.headers.get("Content-Disposition")) ?? fallbackName, blob);
}

export function ExportScreen() {
  const { site } = useSite();
  const datasets = React.useMemo(() => site ? buildDatasetMeta(site) : [], [site]);
  const [mode, setMode] = React.useState<"excel" | "csv">("excel");
  const [sel, setSel] = React.useState<Set<string>>(() => new Set());
  const [done, setDone] = React.useState<string | null>(null);
  // ダウンロード中の表示（null なら待機中）。進行中は全ボタンを無効化して二重実行を防ぐ
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const runningRef = React.useRef(false);
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setSel(new Set(datasets.map((d) => d.key)));
  }, [datasets]);

  if (!site) {
    return <div className="ex-wrap"><div className="pane-sub" style={{ padding: 40 }}>クロールデータを読み込み中…</div></div>;
  }

  // サーバーは完了していないクロールのエクスポートを 409 で拒否する（保存途中の書きかけデータを出さないため）。
  // 無駄なリクエストを出さないよう、事前にボタンを無効化して理由を表示する（応答の 409 も下で表示はできる）。
  const exportable = site.crawl.status === "done";
  const crawlId = site.crawl.id;
  const host = site.host;
  const pendingText = site.crawl.status === "error"
    ? "このクロールはエラーで終了したため、エクスポートできるデータがありません。"
    : "クロールが完了していないため、まだエクスポートできません。完了すると出力できるようになります。";

  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOn = sel.size === datasets.length;
  const chosen = datasets.filter((d) => sel.has(d.key));

  const flash = (msg: string) => {
    setDone(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setDone(null), 2200);
  };

  const csvName = (ds: DatasetMeta) => `${ds.key}_${host}.csv`;

  // ダウンロード処理を1つずつ実行する共通部分（進行中表示・エラー表示・二重実行防止）
  const run = async (task: () => Promise<string>) => {
    // ボタンの無効化が描画に反映される前の連打も ref で弾く
    if (!exportable || runningRef.current) return;
    runningRef.current = true;
    setError(null);
    try {
      flash(await task());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      runningRef.current = false;
      setBusy(null);
    }
  };

  const exportCSVFile = (ds: DatasetMeta) => run(async () => {
    setBusy(`${ds.name} をダウンロード中…`);
    await fetchDownload(api.exportCsvUrl(crawlId, ds.key), csvName(ds));
    return `${ds.name} を CSV 出力しました`;
  });

  const doExcel = () => {
    if (!chosen.length) return;
    return run(async () => {
      setBusy(`Excel を作成中…（${chosen.length} シート）`);
      await fetchDownload(api.exportXlsxUrl(crawlId, chosen.map((d) => d.key)), `export_${host}.xlsx`);
      return `Excel を書き出しました（${chosen.length} シート）`;
    });
  };

  // まとめて個別DL: サーバー側の全件読み込みが重ならないよう、前のダウンロードの完了を待ってから次へ進む。
  // 途中で失敗したらそこで止め、何件目で失敗したかを表示する。
  const doAllCSV = () => {
    const list = chosen;
    if (!list.length) return;
    return run(async () => {
      for (let i = 0; i < list.length; i++) {
        setBusy(`${i + 1}/${list.length} をダウンロード中…（${list[i].name}）`);
        try {
          await fetchDownload(api.exportCsvUrl(crawlId, list[i].key), csvName(list[i]));
        } catch (err) {
          const done = i > 0 ? `${i} 件は保存済みです。` : "";
          throw new Error(`${list[i].name} のダウンロードに失敗しました（${i + 1}/${list.length}）。${done}${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
      return `${list.length} 件の CSV を書き出しました`;
    });
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

        {!exportable && (
          <div className="ex-pending-note">
            <Icon.errors size={15} />
            <span>{pendingText}</span>
          </div>
        )}

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
                  : <button className="btn sm" disabled={!exportable || !!busy} onClick={(e) => { e.stopPropagation(); void exportCSVFile(ds); }}><Icon.export size={13} /> CSV</button>}
              </div>
            );
          })}
        </div>

        {/* action bar */}
        <div className="ex-actions">
          <div className="ex-act-info">
            {busy
              ? <span className="ex-busy">{busy}</span>
              : error
              ? <span className="ex-error"><Icon.errors size={15} /> {error}</span>
              : done
              ? <span className="ex-flash"><Icon.check size={15} /> {done}</span>
              : <span className="pane-sub">{chosen.length} 件のデータセットを選択中</span>}
          </div>
          {mode === "excel"
            ? <button className="btn primary" disabled={!chosen.length || !exportable || !!busy} onClick={() => { void doExcel(); }}><Icon.export size={15} /> Excel をダウンロード（{chosen.length} シート）</button>
            : <button className="btn primary" disabled={!chosen.length || !exportable || !!busy} onClick={() => { void doAllCSV(); }}><Icon.export size={15} /> 選択をまとめて個別DL（{chosen.length} 件）</button>}
        </div>
      </div>
    </div>
  );
}
