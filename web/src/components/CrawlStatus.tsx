/* ============================================================
   クロール開始・中止まわりの共通表示
   - CrawlNoticeToast   : 開始/再クロール/中止の結果通知（409 実行中・429 レート制限・失敗）
   - CrawlRunningPlaceholder : 表示対象のクロールが実行中のとき、ダッシュボード以外の画面に出す
   ============================================================ */
import { Icon } from "./icons";
import { useSite } from "../lib/SiteContext";

export function CrawlNoticeToast({ onShowProgress }: { onShowProgress: () => void }) {
  const { notice, dismissNotice, followRunning } = useSite();
  if (!notice) return null;
  // 実行中(409)は「失敗」ではないので警告色、レート制限(429)は情報色、それ以外の失敗はエラー色
  const cls = notice.kind === "busy" ? "warn" : notice.kind === "rate" ? "info" : "err";
  const runningId = notice.runningId;
  return (
    <div className={"crawl-notice " + cls} role="status">
      {notice.kind === "rate" ? <Icon.refresh size={15} /> : <Icon.errors size={15} />}
      <div className="crawl-notice-tx">
        {notice.text}
        {runningId && (
          <div className="crawl-notice-act">
            <button className="btn sm" onClick={() => { void followRunning(runningId); onShowProgress(); }}>
              実行中のクロールの進捗を表示
            </button>
          </div>
        )}
      </div>
      <button className="btn ghost icon sm" title="閉じる" onClick={dismissNotice}><Icon.close size={13} /></button>
    </div>
  );
}

export function CrawlRunningPlaceholder({ onShowProgress }: { onShowProgress: () => void }) {
  const { site, crawlRun } = useSite();
  const run = site && crawlRun?.id === site.crawl.id ? crawlRun : null;
  return (
    <div className="crawl-running-ph">
      <div style={{ maxWidth: 420 }}>
        <div className="ic"><Icon.refresh size={24} /></div>
        <h2>クロール中です{run ? `（${Math.round(run.pct)}%）` : ""}</h2>
        <p className="pane-sub">
          {site?.host} をクロールしています。完了すると結果がこの画面に表示されます。<br />
          進捗の確認と中止はダッシュボードから行えます。
        </p>
        <button className="btn sm" onClick={onShowProgress}>ダッシュボードで進捗を見る</button>
      </div>
    </div>
  );
}
