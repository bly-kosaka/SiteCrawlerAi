# SiteCrawlerAI セキュリティ修正 — 第三者レビュー依頼仕様書

## 0. このドキュメントの目的

本ツール(SiteCrawlerAI)の本番公開に向けて実施した、レッドチーム形式の脆弱性診断とその修正一式について、**実装者(Claude/Anthropic)とは独立した第三者AIによるレビュー**を依頼するための仕様書です。

レビュー観点は以下を想定しています:
- 修正方針・実装に見落とし、論理的な誤り、回避可能な抜け道がないか
- 「直した」と称している箇所が実際に脅威を解消できているか(中途半端な修正になっていないか)
- 新たに導入した仕組み自体が新しいリスクを生んでいないか
- 優先度づけや「対応不要と判断した項目」の妥当性

レビュー対象はこのドキュメントに記載したコード抜粋・差分要約のみで判断可能なように構成していますが、必要であれば実際のファイルパスも記載しているので、リポジトリ全体を参照しても構いません。

---

## 1. アプリケーション概要

**SiteCrawlerAI**: 指定したWebサイトをクロールし、サイトマップ・リンク構造・SEO上の問題(エラー、リダイレクト、孤立ページ等)を可視化する内部向けツール。

### スタック
- バックエンド: Node.js + Fastify(常駐サーバー)、Prisma + SQLite
- クローラー: `undici`(軽量フェッチ)+ `Playwright`(JSレンダリングが必要なページ用、Chromiumヘッドレス)
- フロントエンド: React + Vite (SPA)
- 認証モデル: ユーザーアカウント基盤を持たない、単一の共有APIキー(`API_KEY`環境変数)による「内部向けツール」想定

### 想定脅威モデル
- 公開URLに対し外部からHTTPでアクセス可能になる(本番公開)
- クロール対象は**ユーザーが入力した任意のURL**であり、信頼できない外部ホストへの接続を伴う(SSRFの主要な攻撃面)
- フロントエンドのビルド成果物は誰でも取得可能(JSバンドルに秘密情報を含めてはならない)

---

## 2. レッドチーム診断で識別した指摘事項と対応一覧

修正前の状態(脆弱性)→ 修正後の状態、の対比で記載します。

### [Critical] APIキーをフロントエンドのビルドに平文で埋め込んでいた

**指摘内容**: `web/.env` の `VITE_API_KEY` にAPIキーを設定し、Viteのビルド時に `import.meta.env.VITE_API_KEY` が**リテラル文字列としてJSバンドルに埋め込まれる**構成になっていた。本番公開後はビルド成果物(`dist/assets/*.js`)を誰でも取得できるため、ブラウザの開発者ツールやネットワークタブを見るまでもなく、**配布されたJSファイルをテキスト検索するだけでAPIキーが平文で読み取れる**状態だった。これは「共有シークレットによるAPIキー認証」という設計そのものを無効化する致命的な欠陥である。

**修正方針**: 「APIキーをブラウザに渡しきる」設計自体をやめ、**ログインフロー + 署名付きセッションCookie**方式に変更した。

- ユーザーは初回アクセス時にログイン画面でAPIキーを一度だけ入力する
- サーバー(`POST /api/login`)が `safeCompare`(後述)でAPIキーを検証し、成功時に**署名付き・httpOnly・secure(本番時)・SameSite=Lax**なセッションCookie(`scai_session`、値は固定文字列`"ok"`)を発行する
- 以後、ブラウザは自動的にこのCookieを送信し、サーバーはCookieの署名を検証するだけで認証する(APIキー自体はブラウザのJS/ストレージ/バンドルのどこにも存在しない)
- Cookieの署名(HMAC)には`@fastify/cookie`の`secret`オプションを使い、既存の高エントロピーな`API_KEY`を流用(別途`SESSION_SECRET`を増やさない判断)

**該当コード** (`server/src/index.ts`):
```ts
const SESSION_COOKIE = "scai_session";
const SESSION_COOKIE_VALUE = "ok";
const SESSION_COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  secure: IS_PRODUCTION,       // NODE_ENV=production の時のみ true
  sameSite: "lax" as const,
  signed: true,
  maxAge: 60 * 60 * 24 * 30,   // 30日
};

await app.register(cookie, { secret: API_KEY });

app.addHook("onRequest", async (req, reply) => {
  const url = new URL(req.url, "http://internal");
  if (PUBLIC_PATHS.has(url.pathname)) return;   // /api/health, /api/login, /api/logout

  const sessionCookie = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionCookie === "string") {
    const unsigned = req.unsignCookie(sessionCookie);
    if (unsigned.valid && unsigned.value === SESSION_COOKIE_VALUE) return;
  }

  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && safeCompare(headerKey, API_KEY)) return;

  return reply.code(401).send({ error: "unauthorized" });
});

app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);   // zod: z.object({ apiKey: z.string().min(1) })
  if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
  if (!safeCompare(parsed.data.apiKey, API_KEY)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  reply.setCookie(SESSION_COOKIE, SESSION_COOKIE_VALUE, SESSION_COOKIE_OPTS);
  return { ok: true };
});
```

フロントエンド側 (`web/src/lib/api.ts`, `web/src/components/LoginScreen.tsx`, `web/src/App.tsx`):
- `App.tsx` がマウント時に `GET /api/me` でセッション有無を確認し、未ログインなら `LoginScreen` を表示
- すべての `fetch` に `credentials: "include"` を付与(`request()` ヘルパーで一元化)、401を専用の `UnauthorizedError` として扱う
- `EventSource`(SSE)も `withCredentials: true` で生成しているため、Cookieが自動送信され `?key=` クエリ方式が不要になった

**互換性維持**: `x-api-key` ヘッダーによる直接認証は残した(スクリプト/外部連携用)。「呼び出し元はもともとキーを保持しているため、ヘッダー送付による追加の漏えいリスクは無い」という判断。

**レビューしてほしい点**:
- 固定値Cookie(`"ok"`を署名するだけ)というセッション設計に脆弱性がないか。署名鍵が漏洩しない限り偽造できない、という前提で問題ないか
- `signed: true` の Cookie に対し、有効期限切れや署名アルゴリズムの強度について懸念がないか
- ログイン試行に対するレート制限(`max: 10 / 1分`)は適切か。アカウントロックアウト等の追加対策は不要と判断してよいか

---

### [Medium] APIキーがSSEのクエリパラメータとしてアクセスログに残る

**指摘内容**: 進捗通知(SSE, `EventSource`)の認証のために `?key=<APIキー>` をURLへ平文で付与していた。これは(a) サーバーやリバースプロキシのアクセスログに恒久的に記録される、(b) リファラ経由で外部に漏れる可能性がある、という典型的な「機密情報をURLに載せてはいけない」問題だった。

**修正方針**: 上記Critical項目の修正(Cookieセッション化)が**副次的にこの問題も解消**した。`EventSource` は元々 `withCredentials: true` で生成されており、Cookie認証へ統一したことで `?key=` を完全に廃止できた。

**該当コード** (`web/src/lib/api.ts`):
```ts
// 旧: progressUrl: (id) => `${BASE}/api/crawls/${id}/progress?key=${API_KEY}`
// 新:
progressUrl: (id: string) => `${BASE}/api/crawls/${id}/progress`,
```

**レビューしてほしい点**:
- 「Critical項目の修正で副作用的にMedium項目も解決した」という説明に論理の飛躍がないか。SSE接続が本当にCookieのみで認証され、サーバー側で漏れなく検証されているか(`onRequest`フックがSSEのGETリクエストにも適用される設計になっているかを含む)

---

### [High] `robots.txt` 取得処理がSSRF検証を完全にバイパスしていた

**指摘内容**: クローラー本体(`fetcher.ts` 経由の通常のページ取得)は接続直前に `assertPublicHost()` でSSRF検証(プライベートIP・クラウドメタデータ・localhost等への接続を拒否)を行っていたが、`robots.ts` の `fetchRobots()` は **`undici.request()` を直接呼び出しており、検証を一切経由していなかった**。

これは「検証が甘い」程度の話ではなく、**ゼロ件**の検証だったという点で重大度が高い。攻撃者が `http://169.254.169.254/` のような内部アドレスをクロール対象として指定した場合、通常のページ取得はブロックされても、`{origin}/robots.txt` への最初のリクエストはノーチェックで内部ネットワークに到達してしまう経路だった。

**修正方針**: `fetchRobots()` の冒頭、リクエスト発行前に `assertPublicHost()` を呼び出す形に変更。`HostPinCache`(クロール開始時に観測したDNS解決結果を記録し、途中で変化した場合にDNSリバインディングとして検知する仕組み、詳細は3節)も通常のクロールパスと同じものを共有させ、整合性を保った。

**該当コード** (`server/src/crawler/robots.ts`):
```ts
async function fetchRobots(origin: string, pinCache?: HostPinCache): Promise<RobotsRules | null> {
  if (cache.has(origin)) return cache.get(origin)!;
  let result: RobotsRules | null = null;
  try {
    await assertPublicHost(new URL(origin).hostname, pinCache);
    const res = await request(`${origin}/robots.txt`, { method: "GET" });
    // ...(パース処理)
  } catch (err) {
    // SSRFブロックは「robots.txtが無かった」とは別物として扱い、揉み消さずに伝播させる
    if (err instanceof SsrfBlockedError) throw err;
    result = null;
  }
  cache.set(origin, result);
  return result;
}
```

呼び出し元 (`server/src/crawler/engine.ts:190`):
```ts
const allowed = await isAllowedByRobots(origin, item.path, respectRobots, hostPinCache);
```

**レビューしてほしい点**:
- `catch` ブロックで `SsrfBlockedError` だけを再送出し、それ以外を `result = null` として握りつぶす設計が適切か(robots.txt取得の他のエラー、たとえばタイムアウトやDNS解決失敗一般を「robots.txtなし」として扱って良いかという業務要件的な判断を含む)
- `cache`(モジュールスコープのMap、`origin`をキーとする)が複数クロールジョブ間で共有される設計になっているが、これによりSSRFチェックを一度パスしたoriginの結果が他のクロールでも再利用される構造になっていないか。たとえば、最初のクロールでは正規のホストだったが、後続のクロール開始時にDNSが書き換わっている(リバインディング)ようなケースで、`fetchRobots`が`cache.has(origin)`に該当して`assertPublicHost`の再検証をスキップしてしまわないか — **この点は実装者として完全に詰め切れていない可能性があり、特に重点的にレビューしてほしい**
- `engine.ts` 側で `SsrfBlockedError` がワーカーの `try/finally` を抜けて `Promise.all` の reject → `runCrawl` の reject → `executeCrawl` のエラーハンドラまで正しく伝播することを実装者は確認済みとしているが、その経路に取りこぼしがないか

---

### [Low] `normalizeHost` が正規表現ベースで誤ったホスト名を表示する

**指摘内容**: `input.replace(/^https?:\/\//, "").replace(/\/.*$/, "")` という正規表現処理を生のユーザー入力に対して行っていたため、`http://user:pass@example.com/` のような入力に対し `user:pass@example.com` を返してしまっていた。クロール自体は `new URL().hostname` を使った正しい値に対して行われるため実害(SSRF回避等)は無いが、UI上の表示と実際の接続先が食い違う「スプーフィングの材料」になり得た。

**修正方針**: `new URL(input).hostname` によるパースベースの実装に変更、パース失敗時のみ旧ロジックへフォールバック。

**該当コード** (`server/src/crawler/url.ts`):
```ts
export function normalizeHost(input: string): string {
  try {
    return new URL(input.trim()).hostname;
  } catch {
    return input
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\/+$/, "");
  }
}
```

**レビューしてほしい点**:
- XSSへの懸念は「Reactは既定でエスケープし、コードベースに `dangerouslySetInnerHTML` が存在しない」ことを `grep` で確認済みとして却下しているが、この判断が妥当か(他の出力経路 — エクスポートファイル名、ログ、HTMLレポート生成等 — に表示用ホスト名が渡る箇所が漏れていないか)

---

### [Low] Cookie属性とリバースプロキシ配下でのレート制限精度

**指摘内容**:
1. 既存の「アクティブクロール選択」用Cookie(`scai_active`)に `httpOnly`/`secure` 属性が設定されていなかった
2. `@fastify/rate-limit` は `request.ip` をキーとするが、リバースプロキシ配下では `trustProxy` が無効だと全リクエストがプロキシのIPからに見え、レート制限が事実上「全クライアント合算」になってしまう

**修正方針**:
1. フロントエンドのJSがこのCookieを読んでいないことを確認した上(`grep -rn "scai_active|document.cookie"` で該当なし)、`httpOnly: true` を追加。`secure` は本番(`NODE_ENV=production`)でのみ有効化(開発時の `http://localhost` で保存されなくなるのを防ぐため)
2. `TRUST_PROXY` という新しい環境変数(デフォルト無効・オプトイン)を追加し、有効化時のみ `Fastify({ trustProxy: true })` とする。盲目的に `X-Forwarded-For` を信頼するとIP偽装が可能になるため、明示的なオプトインとした

**該当コード** (`server/src/routes/crawls.ts`):
```ts
const ACTIVE_COOKIE_OPTS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};
```

(`server/src/index.ts`):
```ts
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
// ...
const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });
```

**レビューしてほしい点**:
- `TRUST_PROXY` を「オプトイン」とした設計判断は妥当か。デプロイ手順で `TRUST_PROXY=true` の設定漏れがあった場合に生じる実害(レート制限の精度低下のみで、認可上のバイパスにはならない、という理解で良いか)を再確認してほしい

---

### [Low] `.gitignore` 未整備による秘密情報のコミットリスク

**指摘内容**: `server/.gitignore` が存在せず、`web/.gitignore` も `.env` を除外していなかった。バージョン管理を開始した際に `API_KEY` やSQLite DBファイル、ログファイルがコミットされるリスクがあった。

**修正方針**: 新規作成・追記。

`server/.gitignore` (新規):
```
node_modules
dist
.env
.env.*
!.env.example
*.db
*.db-shm
*.db-wal
*.db-journal
*.log
```

`web/.gitignore` (追記):
```
.env
.env.*
!.env.example
```

**レビューしてほしい点**:
- 除外パターンの過不足(たとえば `*.db-journal` 以外のSQLite一時ファイル形式の見落とし、ビルド成果物ディレクトリ名の相違など)

---

## 3. 今回の修正範囲外で「対応不要」と判断し、そのまま残した既存の防御機構(参考情報)

レビューの土台として、今回**手を加えていない**既存のSSRF対策の概要も共有します(こちら自体への指摘も歓迎します)。

`server/src/crawler/ssrf.ts`:
- `assertPublicHost(hostname, pinCache?)`: ホスト名を解決し、解決済みIPすべてが「プライベート/予約済みアドレスでない」ことを検証。IPv4/IPv6の主要な予約レンジ(ループバック、リンクローカル、CGNAT、クラウドメタデータ`169.254.169.254`を含む169.254.0.0/16、ULA等)を網羅
- `HostPinCache`(`Map<string, string[]>`): クロール単位で生成し、「同一ホストについて最初に観測したDNS解決結果」を記録。以降の検証で値が変化した場合は `SsrfBlockedError` を投げてクロール全体を中断する、軽量なDNSリバインディング変化検知
- 既知の制約として「検証用の名前解決」と「実際に接続するundici/Chromiumが行う名前解決」は別物であり、検証で得たIPに接続を固定(ピン留め)するものではない、という残存リスクをコメントで明示している(真のTOCTOU解消にはカスタムdispatcher/host-resolver-rulesが必要だが複雑さに見合わないと判断)

---

## 4. 実施した検証

- 型チェック: `npx tsc --noEmit`(server)、`npx tsc -b`(web)— いずれもエラーなし
- 機能検証(curlベースの一連のシナリオ):
  - 未認証アクセス → `401`
  - 誤ったAPIキーでログイン → `401`
  - 正しいAPIキーでログイン → `200`、`Set-Cookie: scai_session=ok.<署名>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`(開発環境のため`Secure`属性は付与されない=想定通り)
  - 認証済みセッションで `/api/me`、`/api/crawls` 等にアクセス可能
  - ログアウト後は再度 `401`
  - `x-api-key` ヘッダーによる認証も独立して機能することを確認
- 実クロール2件を新しい認証フロー経由で実行し、SSRF検証・`HostPinCache`・robots.txt修正・スキーム保持が組み合わさった状態で正常に動作することを確認(完了ステータス `done`、ページ取得成功)

---

## 5. レビュー時に特に重点を置いてほしいポイント(まとめ)

1. **robots.txtキャッシュとSSRF検証の相互作用**(2節 [High] 項目): `fetchRobots`の`cache`がSSRFチェックをバイパスする経路を生んでいないか
2. **セッションCookie設計の妥当性**: 固定値+署名という方式の安全性、有効期限・属性設定
3. **`SsrfBlockedError`のエラーハンドリングの分岐**: 「ブロックは伝播、その他は握りつぶし」という設計が業務要件と衝突しないか
4. **見落とされている可能性のある指摘事項**: 上記以外に、レッドチーム視点で見て対応すべき項目が残っていないか(今回の指摘リストはあくまで一回の診断結果であり、網羅性を保証するものではない)
