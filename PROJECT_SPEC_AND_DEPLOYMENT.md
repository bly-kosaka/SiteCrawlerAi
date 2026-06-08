# SiteCrawlerAI — プロジェクト仕様書 兼 公開作業依頼資料

本書は、本プロジェクトの仕様をまとめると同時に、**サーバーエンジニアへ公開(本番デプロイ)作業を依頼するための引き継ぎ資料**を兼ねています。「1. プロジェクト仕様」は全体理解のため、「2. 公開にあたって必要な事項」は実際の作業に直接使える情報として構成しています。

リポジトリ: https://github.com/bly-project/SiteCrawlerAi

---

# 1. プロジェクト仕様

## 1.1 概要

**SiteCrawlerAI** は、指定したWebサイトをクロールし、サイト構造・SEO上の問題を可視化する**内部向けの分析ツール**です。ユーザーがクロール対象のURLを入力すると、サーバー側でサイト全体を巡回し、サイトマップ・リンク構造・エラー・リダイレクト・孤立ページなどを検出してダッシュボード上に表示します。結果はExcel/CSV形式でエクスポート可能です。

## 1.2 主な機能

- **クロール実行**: 起点URL・最大深度・JSレンダリング有無(Playwright使用)を指定して実行。進捗はSSE(Server-Sent Events)でリアルタイム表示
- **サイトマップ表示**: ツリー構造・リンク構造グラフの可視化
- **問題検出**: リンク切れ、リダイレクト連鎖、孤立ページ、タイトル/H1重複、noindex、低速ページ(TTFB)等を自動検出し一覧表示
- **再クロール**: 既存クロール設定の再実行
- **複数クロール管理**: 過去のクロール結果を保存し、アクティブなクロールを切り替えて閲覧
- **エクスポート**: 分析結果をExcel(.xlsx)/CSV形式でダウンロード
- **robots.txt 準拠**: クロール時に robots.txt のルールを尊重(オプション)

## 1.3 アーキテクチャ・技術スタック

```
[ ブラウザ(SPA) ] --HTTPS--> [ リバースプロキシ ] --> [ Fastifyサーバー(Node.js, 常駐) ] --> [ SQLite(Prisma) ]
                                                              |
                                                              +--> [ Playwright(Chromiumヘッドレス) ]
                                                              +--> [ undici(軽量HTTPフェッチ) ]
                                                              +--> [ 外部サイト(クロール対象、任意のURL) ]
```

| 層 | 技術 |
|---|---|
| バックエンド | Node.js + Fastify(常駐サーバー、ポート3001) |
| DB | SQLite + Prisma ORM(WALモード) |
| クローラー | `undici`(軽量フェッチ)+ `Playwright`(JSレンダリングが必要なページ用、Chromiumヘッドレス) |
| フロントエンド | React + Vite(SPA、静的ファイルとしてビルド) |
| 認証 | 共有APIキー + サーバー管理セッション(Cookie、詳細は1.5節) |

**重要**: バックエンドは**常駐プロセス**として動作し、SQLiteへ継続的に読み書きし、必要に応じてChromiumを起動します。これは静的ファイルサーバーやCGI/PHP型の実行環境とは根本的に異なる実行モデルです(2節で詳述)。

## 1.4 ディレクトリ構成

```
SiteCrawlerAI/
├── server/              バックエンド(Fastify + Prisma)
│   ├── src/
│   │   ├── index.ts             エントリポイント、認証、CORS、レート制限
│   │   ├── crawler/             クロールエンジン、SSRF対策、robots.txt処理
│   │   ├── security/            セッション管理
│   │   ├── routes/              APIルート(crawls, analysis, export)
│   │   ├── analysis/            分析ロジック
│   │   └── export/              Excel/CSV出力
│   ├── prisma/                  DBスキーマ・マイグレーション
│   ├── package.json
│   └── .env.example             環境変数テンプレート
└── web/                 フロントエンド(React + Vite)
    ├── src/
    ├── package.json
    └── .env.example             環境変数テンプレート
```

## 1.5 認証・セキュリティ設計(重要)

本ツールはユーザーアカウント基盤を持たず、**単一の共有APIキー(`API_KEY`環境変数)**で保護される内部向けツールです。

- ブラウザ: ログイン画面でAPIキーを一度入力 → サーバーが**サーバー側DB(SQLiteの`Session`テーブル)で管理するセッション**を発行し、署名なし・httpOnly・secure(本番時)・SameSite=LaxなCookie(`scai_session`)としてブラウザへ渡す。以後はCookieによる自動認証
  - セッションはアイドル12時間/絶対7日でサーバー側が強制的に失効させ、ログアウト時にもDB側から即時削除する(漏えいしたCookieが再利用され続けることを防ぐ設計)
- スクリプト/外部連携: `x-api-key` ヘッダーによる直接認証(後方互換のため維持)
- **SSRF対策**: クロール対象は信頼できない外部ホストであるため、接続直前に毎回 `assertPublicHost()` でプライベートIP/クラウドメタデータ/localhost等への接続をブロックし、`HostPinCache`でDNSリバインディングの兆候も検知する
- レート制限・CORS・Helmetによるセキュリティヘッダーを適用済み

> 過去に実施したレッドチーム診断と対応の詳細は `SECURITY_FIX_REVIEW_SPEC.md` / `SECURITY_FIX_IMPLEMENTATION_PLAN_B.md` を参照してください(本リポジトリに同梱)。

---

# 2. 公開にあたって必要な事項(サーバーエンジニア向け)

## 2.1 必須となるサーバー要件 ★最重要

本アプリは以下の3点の理由により、**従来型の共用レンタルサーバー(CGI/PHP型のホスティング)では動作しません**。root権限を持つVPS/クラウドサーバー(Linux)が必要です。

1. **常駐Node.jsプロセスが必須**: Fastifyサーバーは継続的に起動し続けるデーモンプロセスです。リクエスト毎に起動するCGI型の実行モデルとは異なり、`systemd`や`pm2`等による常駐管理が必要です
2. **SQLiteへの継続的な読み書き(WALモード)**: ファイルベースのDBに対しサーバープロセスが直接読み書きします
3. **Playwright(Chromiumヘッドレス)の実行**: JSレンダリングを伴うクロールには、OSレベルの依存ライブラリ込みでヘッドレスブラウザを実行する必要があります(`npx playwright install --with-deps chromium`によるシステムパッケージのインストールが必要)

### 推奨スペック
- OS: Ubuntu 22.04 LTS等(Debian系Linux)
- メモリ: **最低2GB、可能であれば4GB以上**(Chromiumがメモリを多く消費するため。同時実行クロール数が多い場合はさらに必要)
- ディスク: SQLiteのDBファイル+クロール結果の蓄積を考慮し余裕を持たせる
- root権限(パッケージインストール、サービス常駐化のため)

## 2.2 ソフトウェア要件

- Node.js LTS版(プロジェクトの`@types/node`バージョンから推測し、Node.js 20系以上を推奨)
- `npx playwright install --with-deps chromium` でChromiumと依存パッケージをインストール
- リバースプロキシ(Nginx推奨)+ TLS証明書(Let's Encrypt等)
- プロセスマネージャー: `systemd` または `pm2`

## 2.3 必要な環境変数

### `server/.env`(`.env.example`を元に作成、**機密情報のため`.env.example`以外はコミット禁止**)

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DATABASE_URL` | ◯ | SQLiteファイルへのパス(例: `file:./prod.db`) |
| `PORT` | ◯ | リッスンポート(デフォルト3001、リバースプロキシの転送先と一致させる) |
| `API_KEY` | ◯ | **共有APIキー。`openssl rand -hex 32`等で生成した高エントロピーなランダム文字列を設定すること。** これが漏れるとツール全体が乗っ取られるため厳重に管理 |
| `CORS_ORIGIN` | ◯ | フロントエンドの公開オリジン(例: `https://sitecrawler.example.com`)。複数指定はカンマ区切り |
| `NODE_ENV` | 推奨 | 本番では`production`を設定(これによりCookieに`Secure`属性が付与される。**設定し忘れるとブラウザがCookieを保存できずログインできない**ので要注意) |
| `TRUST_PROXY` | 状況による | リバースプロキシ配下で動かす場合は`true`に設定(レート制限がクライアント単位で正しく機能するようになる)。直接公開する構成では設定しないこと(IP偽装を許してしまうため) |

### `web/.env`(ビルド時に使用、ビルド成果物に埋め込まれる — 秘密情報は入れない)

| 変数名 | 必須 | 説明 |
|---|---|---|
| `VITE_API_BASE` | ◯ | バックエンドAPIの公開URL(例: `https://api.sitecrawler.example.com` またはバックエンドと同一オリジンならば不要) |

## 2.4 デプロイ手順(概要)

### サーバー側セットアップ
```bash
# 1. Node.js, git等の基本セットアップ後
git clone https://github.com/bly-project/SiteCrawlerAi.git
cd SiteCrawlerAi/server

# 2. 依存関係インストール
npm ci

# 3. Playwright + Chromium(システム依存パッケージ込み)
npx playwright install --with-deps chromium

# 4. 環境変数を設定(.env.example を元に .env を作成、API_KEYは必ず生成し直す)
cp .env.example .env
# vi .env で編集

# 5. DBマイグレーション(本番反映用。migrate dev ではなく deploy を使用)
npx prisma migrate deploy

# 6. ビルド
npm run build

# 7. 起動確認
npm start
```

### フロントエンド側ビルド
```bash
cd ../web
npm ci
cp .env.example .env
# VITE_API_BASE を本番のAPIエンドポイントに設定して編集

npm run build
# dist/ 以下が静的ファイル一式。Nginx等で配信する
```

### 常駐化(例: systemd)
`server`をsystemdサービスとして登録し、`npm start`(= `node dist/index.js`)を自動起動・再起動するよう設定してください。

### リバースプロキシ構成(例: Nginx)
- `https://<フロントのドメイン>/` → `web/dist` の静的ファイル配信
- `https://<フロントのドメイン>/api/*` (またはサブドメイン) → `localhost:3001` へプロキシ
- TLS終端をリバースプロキシ側で行う(`NODE_ENV=production`と組み合わせ、Cookieの`Secure`属性が機能するようにする)
- SSE(進捗表示, `/api/crawls/:id/progress`)はストリーミング応答のため、プロキシ側でバッファリングを無効化すること(Nginxの場合 `proxy_buffering off;` 等)

## 2.5 公開後の運用上の注意点

- **`API_KEY`の管理**: 漏洩した場合は値を再生成し`.env`を更新、サーバーを再起動してください(全セッションの即時無効化が必要な場合は、DBの`Session`テーブルを空にすることでも対応可能です)
- **ログ・DBのバックアップ**: SQLiteファイル(`server/prisma/*.db*`)は定期的にバックアップすることを推奨します
- **クロール対象に関する注意**: 本ツールはユーザーが指定した任意の外部URLへ接続します。組織のネットワークポリシー上、クロール対象を制限したい場合は事前に共有してください(現状はSSRF対策によりプライベートIP/内部ネットワークへの到達のみブロックしています)
- **メモリ監視**: Playwright/Chromiumはメモリを多く消費します。同時実行数が多い・クロール対象サイトが大規模な場合はメモリ使用量を監視してください
- **SSE/EventSourceの接続**: ブラウザがリアルタイム進捗表示のために長時間接続を維持します。プロキシのタイムアウト設定にも注意してください

## 2.6 動作確認チェックリスト(公開後)

- [ ] `https://<ドメイン>/api/health` が `{"ok": true}` を返す
- [ ] フロントエンドにアクセスしログイン画面が表示される
- [ ] 正しいAPIキーでログインでき、Cookieに`Secure`属性が付与されている(ブラウザの開発者ツールで確認)
- [ ] テストサイトに対するクロールが完了し、結果が表示される(SSEによる進捗表示が機能する)
- [ ] エクスポート(Excel/CSV)がダウンロードできる
- [ ] ログアウト後、再度認証が要求される

---

## 補足: 関連ドキュメント

- `SECURITY_FIX_REVIEW_SPEC.md`: レッドチーム診断結果と対応内容の詳細
- `SECURITY_FIX_IMPLEMENTATION_PLAN_B.md`: セッション管理方式の設計検討資料
- `server/.env.example`, `web/.env.example`: 環境変数テンプレート
