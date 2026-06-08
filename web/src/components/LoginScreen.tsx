/* ============================================================
   LoginScreen — APIキーを一度だけ入力してもらい、サーバーに
   署名付き httpOnly Cookie を発行してもらうログイン画面。
   (旧方式: APIキーをビルドへ埋め込み平文で送信していた構成からの置き換え。
    詳しくは lib/api.ts のコメント参照)
   ============================================================ */
import React from "react";
import { login } from "../lib/api";

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [apiKey, setApiKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const ok = await login(apiKey.trim());
      if (ok) {
        onSuccess();
      } else {
        setError("APIキーが正しくありません。");
      }
    } catch {
      setError("サーバーに接続できませんでした。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <form onSubmit={handleSubmit} style={{ width: 320, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Site<b>Mapper</b> ログイン</div>
          <p className="pane-sub" style={{ margin: 0 }}>APIキーを入力してください。</p>
        </div>
        <input
          type="password"
          autoFocus
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="APIキー"
          className="input"
          style={{ width: "100%", height: 38, fontSize: 14 }}
          disabled={submitting}
        />
        {error && <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div>}
        <button type="submit" className="btn primary" disabled={submitting || !apiKey.trim()} style={{ height: 38 }}>
          {submitting ? "確認中…" : "ログイン"}
        </button>
      </form>
    </div>
  );
}
