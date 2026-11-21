# フロントエンドとバックエンドを単一イメージにまとめ、同一オリジンから配信する。
# (別オリジンの2サービス構成だとセッションCookieがサードパーティCookie扱いとなり、
#  ブラウザのプライバシー保護機能でブロックされてログインが維持できない問題があった)

# Node.jsのバージョンはパッチまで固定する(2026年10月のセキュリティリリース v24.22.1 以上を使うこと)。
# 更新時は web-build / 実行ステージの両方を揃えて変更する。

# ---- フロントエンドのビルド ----
# VITE_API_BASE は空文字にする(同一オリジンなので相対パス /api/... で呼び出す)。
FROM node:24.22.1-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
ENV VITE_API_BASE=""
RUN npm run build

# ---- バックエンドのビルド & 実行 ----
# 以前はJSレンダリング用に Playwright の Chromium と OS 依存ライブラリ(libnss3 等)を
# `playwright install --with-deps` で導入していたが、JSレンダリング機能は本番で機能しておらず
# 機能ごと撤去したため、Node 公式の slim イメージに Prisma が必要とするパッケージだけを入れる構成にした。
FROM node:24.22.1-bookworm-slim
WORKDIR /app

# Prismaのクエリエンジンが libssl を必要とするため openssl を入れておく
# (prisma generate をこのイメージ内で実行するため、エンジンは実行環境の OpenSSL 3 系
#  (debian-openssl-3.0.x)向けが自動選択される。schema.prisma の binaryTargets 指定は不要)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# glibc の malloc はスレッドごとにアリーナ(メモリ領域)を作り、既定では CPU コア数×8 個まで増える。
# Prisma のクエリエンジン(Rust)や libuv のスレッドが確保・解放したメモリがアリーナごとに断片化して
# OS に返らず、常駐メモリ(RSS)が膨らみ続ける原因になるため、アリーナ数を絞る。
ENV MALLOC_ARENA_MAX=2

# 依存関係を先にインストールしてレイヤーキャッシュを効かせる
COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/prisma ./prisma
COPY server/tsconfig.json ./
COPY server/src ./src

# Prisma Clientの生成 + TypeScriptのビルド
RUN npx prisma generate
RUN npm run build

# フロントエンドのビルド成果物を同一オリジンから配信するために配置する
COPY --from=web-build /web/dist ./public

# 起動時にDBマイグレーションを反映してからサーバーを起動する
# (migrate dev ではなく、本番向けの migrate deploy を使う)
# node は exec で起動して sh と置き換え、PID 1 にする。exec しないと PID 1 の sh が SIGTERM を
# node へ転送せず(PID 1 はハンドラ未設定のシグナルを無視する)、Serverless のスリープや再デプロイ時に
# 終了処理(src/index.ts の shutdown)が走らないまま強制終了を待つことになるため。
# trap はマイグレーション実行中(まだ sh が PID 1)に届いた SIGTERM/SIGINT 用。マイグレーションを途中で
# 止めずに完了を待ち、node を起動せずに終了する(trap が無いと sh はシグナルを無視して node を起動してしまう)。
CMD ["sh", "-c", "trap 'exit 143' TERM INT; npx prisma migrate deploy && exec node --max-old-space-size=512 dist/index.js"]
