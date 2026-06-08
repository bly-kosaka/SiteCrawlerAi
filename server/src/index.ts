import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { z } from "zod";
import { createSession, deleteSession, validateAndTouchSession, cleanupExpiredSessions } from "./security/session.js";
import { registerCrawlRoutes } from "./routes/crawls.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerExportRoutes } from "./routes/export.js";

const PORT = Number(process.env.PORT || 3001);

// 本番(HTTPS)では Cookie に secure 属性を付与する。
// ローカル開発(http://localhost)では secure な Cookie はブラウザに保存されないため、
// NODE_ENV=production のときのみ有効化する。
const IS_PRODUCTION = process.env.NODE_ENV === "production";

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

// API認証: 共有シークレットによるシンプルなAPIキー方式。
// 本ツールはユーザーアカウント基盤を持たない内部向けツールであるため、
// 「未設定なら認証なしで起動できてしまう」事故を避けるべく必須環境変数とする。
const API_KEY: string = (() => {
  const v = process.env.API_KEY;
  if (!v) {
    throw new Error(
      "環境変数 API_KEY が設定されていません。`.env` に API_KEY=<ランダムな文字列> を設定してください。" +
        "（誰でもクロールを起動・削除・閲覧できてしまう状態でのサーバー起動を防止しています）"
    );
  }
  return v;
})();

// /api/login, /api/logout はログイン前後で呼ばれるため認証フックの対象外とする
const PUBLIC_PATHS = new Set(["/api/health", "/api/login", "/api/logout"]);

// ブラウザ用のセッションCookie。
// 旧方式(VITE_API_KEYをフロントエンドのビルドに埋め込み、x-api-keyヘッダーや
// SSE用に ?key= クエリへ平文で載せる)は、(a)ビルド成果物を取得すれば誰でも
// APIキーを読み取れてしまう、(b) ?key= がアクセスログに平文で残り続ける、という
// 2つの問題があったため廃止する。
// 代わりに、ユーザーが一度だけAPIキーを入力してログインし、サーバーが
// セッションを発行してCookieに保存させる方式に変更する。
//
// Cookie値は「固定文字列を署名したもの」ではなく、サーバー側DB(security/session.ts)で
// 管理する高エントロピーなセッションIDそのものとする。署名のみに頼る方式は偽造耐性は
// あるが、サーバー側に「真実」を持たないため、ログアウトでの即時失効やTTLの強制が
// できない欠点があった。セッションIDをDBで管理することでこれを解消する
// (詳細は security/session.ts のコメント参照)。
const SESSION_COOKIE = "scai_session";
const SESSION_COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  secure: IS_PRODUCTION,
  // フロントエンドとAPIを別オリジン(別サブドメイン)にデプロイする構成では、
  // SameSite=Lax だと fetch/XHR でCookieが送信されずログイン直後に401になる。
  // SameSite=None には Secure 属性が必須(本番のみ有効)であり、CSRFはCORSの
  // 許可オリジン一覧(originチェック)とJSON Content-Type必須(プリフライト必須)
  // の組み合わせで防いでいるため、ここをNoneにしても新たな穴は生まれない。
  sameSite: IS_PRODUCTION ? ("none" as const) : ("lax" as const),
  // 有効期限の真実はサーバー側セッションストア(DB)のTTLが持つ。Cookie自体の
  // Max-Ageは「ブラウザにできるだけ長く保持してもらう」ための長めの値で構わない。
  maxAge: 60 * 60 * 24 * 30, // 30日
};

const loginSchema = z.object({ apiKey: z.string().min(1) });

// APIキーの比較はタイミング攻撃（応答時間の差からキーを1文字ずつ推測される攻撃）を
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

  // 認証フック。/api/health, /api/login, /api/logout のみ未認証で許可。
  // 二つの認証経路を許容する:
  //   1) ブラウザ: ログインで発行したセッションCookie(値=DBで管理するセッションID)
  //      (EventSourceも withCredentials:true で自動的にCookieを送るため、
  //       SSEのためだけに ?key= をURLへ平文で載せる必要が無くなる)
  //   2) スクリプト/外部連携: x-api-key ヘッダーで直接APIキーを渡す方式
  //      (呼び出し元はもともとキーを保持しているため、ヘッダー送付による
  //       追加の漏えいリスクは無い。アクセスログにも残らない)
  app.addHook("onRequest", async (req, reply) => {
    const url = new URL(req.url, "http://internal");
    // 認証対象は /api/* のみ。フロントエンドの静的ファイル(HTML/JS/CSS)は
    // ログイン画面自体の表示に必要なため、誰でも取得できる必要がある
    // (機密情報を含まない公開ビルド成果物であり、保護すべきはAPI側)。
    if (!url.pathname.startsWith("/api/")) return;
    if (PUBLIC_PATHS.has(url.pathname)) return;

    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (typeof sessionId === "string" && (await validateAndTouchSession(sessionId))) return;

    const headerKey = req.headers["x-api-key"];
    if (typeof headerKey === "string" && safeCompare(headerKey, API_KEY)) return;

    return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  // ログイン: APIキーを検証し、成功したら新しいセッションを発行してCookieに保存する。
  // 既存セッションがあれば失効させてから発行し直す(同一ブラウザでの再ログイン時に
  // 古いセッションIDをDBに残さない)。
  // ブルートフォース対策として、グローバルのレート制限よりさらに厳しく絞る。
  app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    if (!safeCompare(parsed.data.apiKey, API_KEY)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const existing = req.cookies?.[SESSION_COOKIE];
    if (typeof existing === "string") await deleteSession(existing);

    const sessionId = await createSession();
    reply.setCookie(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTS);
    return { ok: true };
  });

  // ログアウト: Cookieを破棄するだけでなく、DB側のセッションも削除する。
  // これにより、Cookieが漏えいしていた場合でもログアウト後は再利用できなくなる
  // (旧:署名付き固定値Cookie方式では、漏えいしたCookie自体は署名検証を通って
  //  しまうため、ログアウトでは「ブラウザの保持」を消せても「Cookie値そのものの
  //  有効性」までは奪えなかった)。
  app.post("/api/logout", async (req, reply) => {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (typeof sessionId === "string") await deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // フロントエンド起動時に「ログイン済みか」を判定するための軽量エンドポイント。
  // onRequestフックを通過できた時点で認証済みであることが保証されるため、
  // ここでは200を返すだけでよい。
  app.get("/api/me", async () => ({ ok: true }));

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

  // 期限切れセッションの定期掃除。検証時の個別削除だけでは「発行後一度も
  // 使われずに放置されたセッション」がDBに残り続けるため、別途間引いて掃除する。
  const cleanupTimer = setInterval(() => {
    cleanupExpiredSessions().catch((err) => app.log.error(err, "セッション掃除に失敗しました"));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
