import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import compress from "@fastify/compress";
import basicAuth from "@fastify/basic-auth";
import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { recoverOrphanedCrawls, getRunningCrawlId, cancelCrawl } from "./crawler/manager.js";
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
// Vite のハッシュ付きビルド成果物の出力先(build.assetsDir 既定値 "assets")
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets") + path.sep;

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

// ---- 終了シグナル処理 ----
// Railway の Serverless(無通信時のスリープ)や再デプロイでは SIGTERM が送られ、一定時間内に終了しないと
// SIGKILL で強制終了される。ハンドラが無いと、コンテナの PID 1 として動く node は SIGTERM を無視するため
// 毎回強制終了まで待たされる。受信したら新規受付を止め、DB 接続を閉じて速やかに終了する。
// 実行中のクロールは中止経路(cancelCrawl)で取得を止めるが、保存の完了は短時間しか待たない。
// 保存途中で終了しても、次回起動時の recoverOrphanedCrawls が「実行中」のまま残った行を後始末する。
const SHUTDOWN_TIMEOUT_MS = 8_000; // これを超えたら後始末を諦めて強制終了する
const SHUTDOWN_CRAWL_WAIT_MS = 2_000; // 中止したクロールの保存完了を待つ上限
const SHUTDOWN_HTTP_CLOSE_MS = 2_000; // HTTP サーバーのクローズを待つ上限(SSE 接続が残っていると閉じ切らないため)

let appForShutdown: FastifyInstance | null = null;
let shuttingDown = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// promise の完了を最大 ms だけ待つ(タイムアウトしても promise 自体は止めない)
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    // 終了処理中に再度シグナルを受けた場合(Ctrl+C の連打等)は待たずに終了する
    console.warn(`[shutdown] ${signal} を再度受信したため即時終了します`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} を受信しました。終了処理を開始します`);
  // 終了処理がどこかで止まっても、プラットフォームの強制終了より前に自力で抜ける
  setTimeout(() => {
    console.warn(`[shutdown] 終了処理が ${SHUTDOWN_TIMEOUT_MS}ms 以内に完了しなかったため強制終了します`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    // クロールの中止待ちと HTTP サーバーのクローズ(新規受付の停止)は並行して行い、待ち時間を重ねない
    const waitCrawl = async () => {
      const runningId = getRunningCrawlId();
      if (!runningId) return;
      cancelCrawl(runningId);
      const deadline = Date.now() + SHUTDOWN_CRAWL_WAIT_MS;
      while (getRunningCrawlId() === runningId && Date.now() < deadline) await delay(100);
      if (getRunningCrawlId() === runningId) {
        console.warn(`[shutdown] クロール ${runningId} の保存完了を待たずに終了します(次回起動時にエラーへ訂正されます)`);
      }
    };
    const closeHttp = async () => {
      if (!appForShutdown) return;
      const closed = await waitAtMost(appForShutdown.close(), SHUTDOWN_HTTP_CLOSE_MS);
      if (!closed) console.warn("[shutdown] HTTP サーバーのクローズ待ちを打ち切りました(SSE 等の接続が残っていたため)");
    };
    await Promise.all([waitCrawl(), closeHttp()]);
    await prisma.$disconnect();
  } catch (err) {
    console.error("[shutdown] 終了処理中にエラーが発生しました:", err);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  // 前回プロセスがクラッシュ(OOM等)した際に「実行中」のまま残ったクロールを
  // 起動直後に「エラー」へ訂正する。詳しくは recoverOrphanedCrawls 参照。
  await recoverOrphanedCrawls();

  // 静的ファイル(SPAのJS/CSS/index.html)まで1リクエストごとにログを出すとログ量が膨らむため、
  // Fastify 標準のリクエストログは無効化し、/api/* のみ同等の内容("incoming request" /
  // "request completed")を下のフックで出力する。
  // 注意: disableRequestLogging は標準エラーハンドラのエラーログ(5xx のスタック等)も止めるため、
  // 5xx の原因は下の onError フックで別途出力する。
  const app = Fastify({ logger: true, trustProxy: TRUST_PROXY, disableRequestLogging: true });
  appForShutdown = app;
  const isApiRequest = (url: string) => url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
  // レート制限・Basic認証より前に登録し、それらで弾かれたAPIリクエストも従来どおり記録する
  app.addHook("onRequest", async (req) => {
    if (isApiRequest(req.url)) req.log.info({ req }, "incoming request");
  });
  // 5xx になる例外は(パスを問わず)スタック付きで記録する。4xx(認証失敗・バリデーション等)は
  // 想定内の応答なので、上下のフックの1行ログに任せる。
  app.addHook("onError", async (req, _reply, err) => {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) req.log.error({ req, err }, err.message);
  });
  app.addHook("onResponse", async (req, reply) => {
    if (isApiRequest(req.url)) {
      reply.log.info({ res: reply, responseTime: reply.elapsedTime }, "request completed");
    } else if (reply.statusCode === 401) {
      // /api 以外（SPA 本体・静的ファイル）への Basic 認証失敗も、総当たり等を検知できるよう1行だけ記録する。
      // ブラウザは資格情報の入力前に一度 401 を受け取るため、通常の初回アクセスでも1行出る。
      // 認証に成功した静的ファイルの通常アクセスは従来どおり記録しない。
      reply.log.warn({ req, res: reply }, "unauthorized (non-api)");
    }
  });

  // レスポンス圧縮(br/gzip)。JSON(ページ一覧等)・JS/CSS の転送量を削減する。
  // SSE(/progress)は reply.raw へ直接書き込むため onSend を通らず圧縮・バッファリングされない
  // (加えて既定の圧縮対象 MIME からも text/event-stream は除外されている)。
  await app.register(compress, { global: true });

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
  // キャッシュ方針:
  //  - /assets/* は Vite がファイル名にコンテンツハッシュを付けるため、内容が変われば URL も変わる。
  //    よって1年の immutable キャッシュで再検証リクエスト自体を省く。
  //  - index.html はデプロイのたびに参照するアセット名が変わるため no-cache(毎回 ETag で再検証)。
  //  - それ以外(favicon 等)は従来どおり @fastify/static 既定の "public, max-age=0"。
  await app.register(staticPlugin, {
    root: PUBLIC_DIR,
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.startsWith(ASSETS_DIR)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (path.basename(filePath) === "index.html") {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });
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
