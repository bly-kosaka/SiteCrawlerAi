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
# 以前はPlaywright公式イメージをベースにしていたが、同梱Node.jsのバージョンを制御できず、
# package.json側のplaywrightとイメージのタグがずれやすい問題があったため、
# Node公式イメージ + `playwright install --with-deps` に変更した。
# (--with-deps でChromium実行に必要なOS依存ライブラリ(libnss3等)もapt経由で導入される。
#  ブラウザはnpm ciで入ったplaywright本体と同じバージョンが入るため、乖離による起動失敗が起きない)
FROM node:24.22.1-bookworm-slim
WORKDIR /app

# Prismaのクエリエンジンが libssl を必要とするため openssl を入れておく
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 依存関係を先にインストールしてレイヤーキャッシュを効かせる
COPY server/package.json server/package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

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
CMD ["sh", "-c", "npx prisma migrate deploy && node --max-old-space-size=512 dist/index.js"]
