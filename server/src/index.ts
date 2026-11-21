import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import compress from "@fastify/compress";
import basicAuth from "@fastify/basic-auth";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./db.js";
import { recoverOrphanedCrawls, getRunningCrawlId, cancelCrawl } from "./crawler/manager.js";
import { registerCrawlRoutes } from "./routes/crawls.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerExportRoutes, cleanupExportTmpDir } from "./routes/export.js";

const PORT = Number(process.env.PORT || 3001);

// リバースプロキシ(Nginx/Caddy等)の背後で動かす場合、X-Forwarded-For を信頼して
// クライアントの実IPをレート制限などに反映させる必要がある。直接公開する構成では
// 任意のクライアントが X-Forwarded-For を偽装できてしまうため、明示的にオプトインさせる。
// 指定できる値(Fastify の trustProxy にそのまま渡す):
//  - 未設定・空・"false": 信頼しない(request.ip は接続元。プロキシ配下では全員がプロキシのIPに見える)
//  - "true": すべての段を信頼する(request.ip は X-Forwarded-For の左端 = クライアントが自由に書ける値。
//            レート制限のキーを偽装で変えられるため非推奨。従来からの挙動なので互換のため残す)
//  - 数値(例 "1"): 接続元から数えて信頼するプロキシの段数。request.ip は X-Forwarded-For の右から
//            その段数ぶん遡った値になり、クライアントが左側に書き足した値は無視される(推奨)
//  - カンマ区切りの IP/CIDR(例 "10.0.0.0/8,127.0.0.1"): その範囲からの接続だけをプロキシとして信頼する
//  - "true"/"false" は大文字小文字と前後の空白を無視する。"0" は「信頼しない」
//  - 上記以外(解釈できない値)は、起動を止めずに従来どおり「信頼しない」として起動し、warn を1行出す
//    (本番の現在値が分からないまま、デプロイした瞬間に起動しなくなる事故を避けるため)
//  - 最終的に採用した解釈は起動時に info で1行出す(デプロイ直後にログで確認できるように)
// 注意(段数指定): Fastify 5.12 系は trustProxy に数値を渡すと「何も信頼しない」扱いにする
// (直接つながったクライアントが段数ぶんの X-Forwarded-For を書けば偽装できるため、安全側に倒す仕様)。
// そのため段数は「接続元から数えて n 段目までを信頼する」関数に変換して渡す(proxy-addr / Express の
// 段数指定と同じ意味)。これが安全なのは、アプリへの接続が必ずそのプロキシを経由する(インターネットから
// コンテナへ直接つながらない)構成の場合に限る。Railway のように公開経路がエッジプロキシだけの構成を想定。
type TrustProxySetting = boolean | number | string[];
const TRUST_PROXY_PARSED = parseTrustProxy(process.env.TRUST_PROXY);
const TRUST_PROXY: TrustProxySetting = TRUST_PROXY_PARSED.setting;
const FASTIFY_TRUST_PROXY: boolean | string[] | ((address: string, hop: number) => boolean) =
  typeof TRUST_PROXY === "number"
    ? (() => {
        const hops = TRUST_PROXY;
        return (_address: string, hop: number) => hop < hops;
      })()
    : TRUST_PROXY;

// setting: Fastify へ渡す前の解釈結果。invalid: 解釈できずに「信頼しない」へ倒した場合 true
function parseTrustProxy(raw: string | undefined): { setting: TrustProxySetting; invalid: boolean } {
  const v = (raw ?? "").trim();
  const lower = v.toLowerCase();
  if (lower === "" || lower === "false") return { setting: false, invalid: false };
  if (lower === "true") return { setting: true, invalid: false };
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (Number.isSafeInteger(hops)) return { setting: hops === 0 ? false : hops, invalid: false };
  }
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  const isAddressOrCidr = (s: string) => {
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
    if (!m) return false;
    const family = isIP(m[1]);
    if (family === 0) return false;
    return m[2] === undefined || Number(m[2]) <= (family === 4 ? 32 : 128);
  };
  // IP/CIDR は事前に検証する(不正な値を Fastify(proxy-addr)へ渡すと、生成時に例外で起動が止まるため)
  if (list.length > 0 && list.every(isAddressOrCidr)) return { setting: list, invalid: false };
  return { setting: false, invalid: true };
}

// 採用した trustProxy の解釈を1行で表す(起動時の info ログ用)
function describeTrustProxy(s: TrustProxySetting): string {
  if (s === true) return "all";
  if (s === false) return "none";
  if (typeof s === "number") return `hops=${s}`;
  return `list=[${s.join(", ")}]`;
}

// ---- 認証試行の回数制限 ----
// Basic 認証の総当たり対策。全体のレート制限(120回/分)はルート単位のフックとして認証(アプリ全体の
// onRequest フック)より後に実行されるため、認証に失敗したリクエストは数えられない。そこで認証の
// validate の中で、認証試行専用のリミッターを使う:
//  - 資格情報付きのリクエストは、照合の前に必ず1回数える(並列に大量に送られても、加算は照合より前に
//    同期的に行われるため、上限を超えた分は照合されない)。照合に成功したら1回分を返す(refund)ので、
//    数として残るのは失敗した試行(と処理中の試行)だけになる
//  - 上限を超えている間は、正しい資格情報でも 429 を返す(超過中に正解を当てても成否が分からないようにする)
//  - Authorization ヘッダが無い/形式が不正なリクエスト(ブラウザの初回アクセス等)は validate が呼ばれないので数えない
// 上限値の根拠: 正規の利用者がパスワードを打ち間違える回数(数回)より十分大きく、かつ総当たりの速度を
// 1つのIP(IPv6 は /64)あたり 15分に20回(1日 2,000回弱)まで落とす。パスワード自体は高エントロピーの
// ランダム値を前提としており、この制限はパスワードが弱かった場合や漏えい時の試行を遅らせる多層防御。
// カウンタはプロセスのメモリ上にあるため、再起動(Serverless のスリープ・再デプロイ)で消える。
// IP の判定は TRUST_PROXY の設定に依存する(上記。誤っていると全員が同じ枠を共有するか、偽装で回避される)。
const AUTH_FAIL_MAX = 20;
const AUTH_FAIL_WINDOW = "15 minutes";
const AUTH_FAIL_MESSAGE = "認証の試行回数が上限を超えました。しばらく時間をおいてから再度お試しください。";
// 上限超過の warn ログはキー(IP)ごとに時間枠あたり1回だけ出す(超過後の大量の試行でログが溢れないように)
const authExceededLogged = new Map<string, number>(); // キー → この時刻までは再度出さない

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
    // このプロセスの xlsx 一時ディレクトリを消す(送信中のファイルがあっても、Linux では開いている間は読める)
    await cleanupExportTmpDir();
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
  // 5xx の原因は下の setErrorHandler で別途出力する。
  // (Fastify 5 ではトップレベルの disableRequestLogging オプションが非推奨(FSTDEP023)になったため、
  //  同じ設定を LogController 経由で渡す)
  // frameworkErrors: ルーティング前に検出される不正なURL(デコードできないパーセントエンコード等)を
  // 一律 400 で閉じる。Fastify の既定でも 400 だが、エラー本文にリクエストパスをそのまま埋め込むため
  // 固定文言にしておく。この時点では認証(onRequest)より前なので、未認証者にも同じ 400 が返る。
  // (Fastify 4 では、ルートが1つも無いメソッドの不正URLはここを通らず not-found ハンドラーへ直行していた。
  //  Fastify 5.12.2 以降は not-found 用のルーターも不正URLをここへ回す。下の setNotFoundHandler 参照)
  // パスパラメーターが上限長(maxParamLength、既定 100 文字)を超える場合(FST_ERR_MAX_PARAM_LENGTH)も
  // ここへ来ることがある。ただしルーターは「他に一致するルートが無いとき」にだけこのエラーにするため、
  // 静的配信のワイルドカード(GET/HEAD /*)がある GET/HEAD では到達せず、認証後に通常の 404 になる
  // (未認証なら 401)。到達するのは PATCH/DELETE/POST など、ワイルドカードの無いメソッドのとき。
  // 認証より前に返るため、未認証者に返す応答の種類を増やさないよう不正URLと同じ 400 にそろえる。
  const app = Fastify({
    logger: true,
    trustProxy: FASTIFY_TRUST_PROXY,
    logController: new LogController({ disableRequestLogging: true }),
    frameworkErrors: (err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      if (err.code === "FST_ERR_BAD_URL" || err.code === "FST_ERR_MAX_PARAM_LENGTH") {
        return reply.code(400).send({ error: "bad request" });
      }
      return reply.code(500).send({ error: "internal server error" });
    },
  });
  appForShutdown = app;
  if (TRUST_PROXY_PARSED.invalid) {
    app.log.warn(
      `環境変数 TRUST_PROXY の値 ${JSON.stringify(process.env.TRUST_PROXY)} を解釈できないため、` +
        "「信頼しない」(未設定と同じ)として起動します。受け付ける書式: true / false(大文字小文字は問わない) / " +
        "プロキシの段数(0 以上の整数。0 は信頼しない) / カンマ区切りの IP・CIDR(例: 10.0.0.0/8,127.0.0.1)"
    );
  }
  app.log.info(`trustProxy: ${describeTrustProxy(TRUST_PROXY)}`);
  if (TRUST_PROXY === true) {
    app.log.warn(
      "TRUST_PROXY=true は X-Forwarded-For の左端(クライアントが自由に書ける値)を接続元として扱うため、" +
        "偽装でレート制限・認証試行の制限を回避され得ます。プロキシの段数(例: TRUST_PROXY=1)での指定を推奨します"
    );
  }
  const isApiRequest = (url: string) => url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
  // 401/429 のログ行に付ける接続元の情報。TRUST_PROXY に設定すべき値(プロキシの段数)を本番のログから
  // 判断できるよう、Fastify が採用した ip、信頼した経路 ips(TRUST_PROXY 未設定なら null)、
  // 生の X-Forwarded-For、実際の接続元(socket)を並べて出す。通常の成功リクエストには付けない。
  const clientAddressInfo = (req: FastifyRequest) => {
    const xff = req.headers["x-forwarded-for"];
    return {
      ip: req.ip,
      ips: req.ips ?? null,
      xForwardedFor: typeof xff === "string" ? xff.slice(0, 512) : (xff ?? null),
      remoteAddress: req.socket?.remoteAddress ?? null,
    };
  };
  // レート制限・Basic認証より前に登録し、それらで弾かれたAPIリクエストも従来どおり記録する
  app.addHook("onRequest", async (req) => {
    if (isApiRequest(req.url)) req.log.info({ req }, "incoming request");
  });
  app.addHook("onResponse", async (req, reply) => {
    const authRelated = reply.statusCode === 401 || reply.statusCode === 429;
    if (isApiRequest(req.url)) {
      if (authRelated) {
        // 認証失敗・回数制限は総当たりの検知とプロキシ段数の確認に使うため warn で接続元の情報を付ける
        reply.log.warn({ res: reply, responseTime: reply.elapsedTime, ...clientAddressInfo(req) }, "request completed");
      } else {
        reply.log.info({ res: reply, responseTime: reply.elapsedTime }, "request completed");
      }
    } else if (authRelated) {
      // /api 以外（SPA 本体・静的ファイル）への Basic 認証失敗・回数制限も、総当たり等を検知できるよう1行だけ記録する。
      // ブラウザは資格情報の入力前に一度 401 を受け取るため、通常の初回アクセスでも1行出る。
      // 認証に成功した静的ファイルの通常アクセスは従来どおり記録しない。
      reply.log.warn(
        { req, res: reply, ...clientAddressInfo(req) },
        reply.statusCode === 401 ? "unauthorized (non-api)" : "too many requests (non-api)"
      );
    }
  });
  // エラー応答。4xx(認証失敗・回数制限・入力不正等)は Fastify 標準のエラーハンドラーへそのまま渡し、
  // 応答の形(本文・WWW-Authenticate・Retry-After 等のヘッダ)を変えない。
  // 5xx は内部の情報(ファイルパス・SQL 等)を含み得る err.message を返さず固定文言にし、
  // 詳細はスタック付きでログにだけ出す(パスを問わず。標準のエラーログは disableRequestLogging で
  // 止まっているため、ここが 5xx の唯一の記録になる)。
  app.setErrorHandler((err: FastifyError, req, reply) => {
    let statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;
    if (reply.statusCode < 400) {
      if (err.statusCode && err.statusCode >= 400 && err.statusCode <= 599) statusCode = err.statusCode;
      else {
        const status = (err as { status?: number }).status;
        if (status && status >= 400 && status <= 599) statusCode = status;
      }
    }
    if (statusCode < 500) {
      reply.send(err); // 親(標準)のエラーハンドラーで従来どおりの応答にする
      return;
    }
    req.log.error({ req, err }, err.message);
    reply.code(statusCode).type("application/json; charset=utf-8").send({ error: "internal server error" });
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
    // @fastify/cors v11 で既定の許可メソッドが CORS セーフリストのメソッド(GET/HEAD/POST)のみに変わったため、
    // 従来の既定値(このアプリが使う PATCH/DELETE を含む)を明示する。
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
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
  // ブルートフォース耐性は「高エントロピーなランダムパスワード」と「認証試行の回数制限」
  // (IP ごとに失敗20回/15分。ファイル先頭の AUTH_FAIL_MAX 参照)の組み合わせで担保する。
  // (以前は全体のレート制限で担保しているつもりだったが、全体のレート制限はルート単位のフックとして
  //  認証の後に実行されるため、認証に失敗したリクエストは数えられていなかった)
  // 全体のレート制限を認証より前のアプリ全体のフックへ移す方法は採らない: @fastify/rate-limit は
  // 「このリクエストは数えた」というフラグを共有するため、ルート個別の厳しい制限(クロール開始 5回/分等)
  // が黙って無効になる。createRateLimit で作るリミッターはこのフラグに触れない。
  const authAttemptLimit = app.createRateLimit({ max: AUTH_FAIL_MAX, timeWindow: AUTH_FAIL_WINDOW });
  await app.register(basicAuth, {
    // 通常の onRequest フックからも、not-found ハンドラー内の自前の検証(checkBasicAuth)からも呼ばれる。
    // どちらの経路でも同じカウンタで数える。
    validate: async (username, password, req, reply) => {
      const rl = await authAttemptLimit(req); // 照合の前に1回数える
      if (!rl.isAllowed && rl.isExceeded) {
        const now = Date.now();
        if ((authExceededLogged.get(rl.key) ?? 0) <= now) {
          authExceededLogged.set(rl.key, now + rl.ttl);
          if (authExceededLogged.size > 10_000) {
            for (const [k, until] of authExceededLogged) if (until <= now) authExceededLogged.delete(k);
          }
          // 資格情報(ユーザー名を含む)は出さない
          req.log.warn(
            { ip: req.ip, key: rl.key, attempts: rl.max + 1, limit: rl.max, retryAfterSec: rl.ttlInSeconds },
            "認証試行の回数制限を超えました(以後この時間枠では同じ接続元の超過を記録しません)"
          );
        }
        reply.header("Retry-After", String(rl.ttlInSeconds));
        // statusCode が 401 以外なので @fastify/basic-auth は WWW-Authenticate を付けない
        return Object.assign(new Error(AUTH_FAIL_MESSAGE), { statusCode: 429 });
      }
      if (safeCompare(username, BASIC_AUTH_USER) && safeCompare(password, BASIC_AUTH_PASSWORD)) {
        if (!rl.isAllowed) await authAttemptLimit(req, { refund: true }); // 成功した試行は数から外す
        return;
      }
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
    // 末尾が「/」のパス(「/」自体や「/assets/」などのディレクトリ)はファイルとして配信しない。
    // @fastify/static v10 では index:false のディレクトリ要求が 403 になるため、ここで除外して
    // 従来どおり not-found ハンドラー(SPAフォールバック)へ回す。
    allowedPath: (pathName) => !pathName.endsWith("/"),
    // ドットで始まるファイル・ディレクトリ(.env 等)は配信しない。@fastify/static の既定は "allow"。
    // "ignore" は「存在しない」扱いになり、not-found ハンドラー(SPAフォールバック)へ回る。
    dotfiles: "ignore",
    // @fastify/static v10 以降、setHeaders には生の http.ServerResponse ではなく FastifyReply が渡され、
    // 既定の Cache-Control 等を設定した後に呼ばれる(ここで設定した値が既定値を上書きする)。
    setHeaders: (reply, filePath) => {
      if (filePath.startsWith(ASSETS_DIR)) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (path.basename(filePath) === "index.html") {
        reply.header("Cache-Control", "no-cache");
      }
    },
  });
  // SPAフォールバック兼 404 応答。
  // 経緯(CVE-2026-76169 / GHSA-p68q-wchp-6fh7): Fastify 4 では「ルートが1つも登録されていないメソッド」
  // (PUT 等)で不正なURLが来ると、このハンドラーが onRequest / preHandler フックを一切通らずに直接呼ばれ
  // (= 上の Basic 認証フックがスキップされる)、プロセスが落ちることもあった。
  // Fastify 5.12.2 以降で修正済み(そうした不正URLは上の frameworkErrors で 400 になり、ここへは来ない)だが、
  // 将来の同種の不具合に備えた多層防御として、このハンドラー自体を「ライフサイクル外から呼ばれても安全」に
  // 作る方針は維持する:
  //  - 冒頭で Basic 認証を自前で検証する(検証は @fastify/basic-auth の app.basicAuth をそのまま呼び、
  //    ヘッダの解釈・validate・401 応答の形を通常経路と共有する。通常経路では onRequest で認証済みのため
  //    二重検証になるが、未認証のリクエストは onRequest の 401 で打ち切られてここへ来ないので、401 が
  //    二重に送られることはない)
  //  - reply.sendFile 等のプラグインのデコレーターに依存しない(v4 のその経路の reply には付いておらず、
  //    呼ぶと未捕捉の TypeError でプロセスごと落ちていた)
  //  - 例外を外へ投げない(v4 のその経路では Fastify が例外を捕捉しなかったため)
  app.setNotFoundHandler((req, reply) => {
    handleNotFound(app, req, reply).catch((err) => {
      req.log.error({ err }, "not-found handler failed");
      try {
        if (!reply.sent) reply.code(500).send({ error: "internal server error" });
      } catch {
        // 応答も送れない場合は何もしない(プロセスを落とさないことを優先)
      }
    });
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

// SPA の index.html。sendFile を使わずメモリから返すため、初回に読み込んで保持する。
// web のビルド成果物が無い開発時でも起動できるよう、読めなければ null のままにして次回また読みにいく。
let indexHtml: { body: string; etag: string } | null = null;
async function loadIndexHtml(): Promise<{ body: string; etag: string } | null> {
  if (indexHtml) return indexHtml;
  try {
    const body = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
    // no-cache で毎回再検証させるため ETag を付ける(従来の sendFile と同様に 304 を返せるように)
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    indexHtml = { body, etag };
  } catch {
    return null;
  }
  return indexHtml;
}

// @fastify/basic-auth の検証(app.basicAuth)を Promise 化したもの。失敗時はその Error(statusCode 401 で
// WWW-Authenticate ヘッダ設定済み、または認証試行の回数制限による statusCode 429 で Retry-After 設定済み)
// を返し、成功時は undefined。
function checkBasicAuth(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<Error | undefined> {
  return new Promise((resolve) => {
    app.basicAuth(req, reply, (err?: Error) => resolve(err ?? undefined));
  });
}

// URL のパス部分がデコードできるか(find-my-way がルーティング時に行うデコードと同等の判定)
function isDecodablePath(rawUrl: string): boolean {
  const q = rawUrl.indexOf("?");
  try {
    decodeURI(q === -1 ? rawUrl : rawUrl.slice(0, q));
    return true;
  } catch {
    return false;
  }
}

async function handleNotFound(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // 1. 認証。不正URLの判定より先に行い、未認証者にはURLの正否に関わらず 401 だけを返す
  //    (未認証者に与える情報を増やさないため)。
  const authErr = await checkBasicAuth(app, req, reply);
  if (authErr) {
    // 通常経路と同じエラーハンドラーで 401/429 を返す(本文・ステータス・onResponse の 401/429 ログが揃う)
    reply.send(authErr);
    return;
  }
  // 2. デコードできないURLは 400(frameworkErrors と同じ応答)
  if (!isDecodablePath(req.url)) {
    reply.code(400).send({ error: "bad request" });
    return;
  }
  // 3. SPA フォールバックは GET/HEAD のみ。/api/ 配下とその他のメソッドは JSON の 404。
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://internal").pathname;
  } catch {
    reply.code(400).send({ error: "bad request" });
    return;
  }
  if (pathname.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  const html = await loadIndexHtml();
  if (!html) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  reply.header("Cache-Control", "no-cache").header("ETag", html.etag);
  if (req.headers["if-none-match"] === html.etag) {
    reply.code(304).send();
    return;
  }
  reply.type("text/html; charset=utf-8").send(html.body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
