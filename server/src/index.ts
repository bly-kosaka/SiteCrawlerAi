import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import basicAuth from "@fastify/basic-auth";
import { registerCrawlRoutes } from "./routes/crawls.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerExportRoutes } from "./routes/export.js";

const PORT = Number(process.env.PORT || 3001);

// リバースプロキシ(Nginx/Caddy等)の背後で動かす場合、X-Forwarded-For を信頼して
// クライアントの実IPをレート制限などに反映させる必要がある。直接公開する構成では
// 任意のクライアントが X-Forwarded-For を偽装できてしまうため、明示的にオプトインさせる。
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

// フロントエンド(Viteビルド成果物)を同一オリジンから配信するための静的ファイルディレクトリ。
// 別オリジン配信(2サービス構成)だとセッションCookieがサードパーティCookie扱いとなり、
// ブラウザのプライバシー保護機能でブロックされてログインが維持できない問題があったため、
// 同一オリジン配信に変更した。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../public");

// CORS: 許可オリジンは明示的なリストで管理する（origin:true + credentials:true は
// 「任意オリジンに資格情報付きリクエストを許可する」典型的な誤設定のため避ける）。
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// API認証: HTTP Basic認証(共有ID/PASSWORD)。
// 本ツールは社内で共有して使う内部向けツールであり、ユーザーごとのアカウント基盤を
// 持たせる必要性は薄い。以前はAPIキーを独自のログイン画面に入力する方式だったが、
// 「キーを毎回貼り付ける」UXが社内共有ツールとして使いづらいという声があったため、
// ブラウザ標準のID/PASSWORDダイアログで完結するBasic認証に一本化した
// (これによりログイン画面・セッションDB等の独自実装を丸ごと削除できる利点もある)。
// 「未設定なら誰でも入れてしまう」事故を避けるため、両方とも必須環境変数とする。
const BASIC_AUTH_USER: string = requireEnv("BASIC_AUTH_USER");
const BASIC_AUTH_PASSWORD: string = requireEnv("BASIC_AUTH_PASSWORD");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `環境変数 ${name} が設定されていません。` +
        "（誰でもアプリへ入れてしまう状態でのサーバー起動を防止しています）"
    );
  }
  return v;
}

// ID/PASSWORDの比較はタイミング攻撃（応答時間の差から1文字ずつ推測される攻撃）を
// 避けるため、定数時間比較で行う。timingSafeEqual は長さが異なるとtypeErrorを投げる上、
// 「長さが違う」という情報自体も時間差として漏れ得るため、長さチェックの分岐でも
// ダミー比較を行い、どちらの分岐でも比較コストをほぼ揃える。
function safeCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

async function main() {
  const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });

  await app.register(helmet, {
    // 同一オリジンでSPA(index.html)も配信するため、ページ自身が発行する
    // fetch/EventSource(/api/* への通信)を connect-src 'self' で許可する必要がある。
    // (default-src 'none' のままだと connect-src も 'none' に倒れ、
    //  ページ自身のAPI呼び出しまでブラウザにブロックされてしまう)
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(cors, {
    origin: CORS_ORIGINS,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    // クロール起動はより重い処理のため別途エンドポイント単位でも制限する（routes/crawls.ts参照）
  });

  // Basic認証。アプリ全体(SPAの静的ファイル含む)を対象に、ブラウザ標準の
  // ID/PASSWORDダイアログで認証する。一度入力すればブラウザが資格情報を
  // 保持して以後のリクエストへ自動付与するため、独自のログイン画面・
  // セッション管理(DB)が不要になる。
  // ブルートフォース耐性は「グローバルのレート制限」と「高エントロピーな
  // ランダムパスワード」の組み合わせで担保する(失敗試行を専用にロックする
  // ような仕組みは、本ツールの利用規模に対して過剰と判断)。
  await app.register(basicAuth, {
    validate: async (username, password) => {
      if (safeCompare(username, BASIC_AUTH_USER) && safeCompare(password, BASIC_AUTH_PASSWORD)) return;
      return new Error("unauthorized");
    },
    authenticate: { realm: "SiteCrawlerAI" },
  });
  app.addHook("onRequest", app.basicAuth);

  app.get("/api/health", async () => ({ ok: true }));

  await registerCrawlRoutes(app);
  await registerAnalysisRoutes(app);
  await registerExportRoutes(app);

  // フロントエンド(Viteビルド成果物)を同一オリジンから配信する。
  // index:false にして「/」へのアクセスはSPAフォールバック側に統一する
  // (history APIによるパスベースルーティングを将来導入してもそのまま機能するように)。
  await app.register(staticPlugin, { root: PUBLIC_DIR, index: false });
  app.setNotFoundHandler((req, reply) => {
    const url = new URL(req.url, "http://internal");
    if (url.pathname.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
