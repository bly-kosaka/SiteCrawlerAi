# フロントエンドとバックエンドを単一イメージにまとめ、同一オリジンから配信する。
# (別オリジンの2サービス構成だとセッションCookieがサードパーティCookie扱いとなり、
#  ブラウザのプライバシー保護機能でブロックされてログインが維持できない問題があった)

# ---- フロントエンドのビルド ----
# VITE_API_BASE は空文字にする(同一オリジンなので相対パス /api/... で呼び出す)。
FROM node:20-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
ENV VITE_API_BASE=""
RUN npm run build

# ---- バックエンドのビルド & 実行 ----
# Playwright公式イメージ: Chromium実行に必要なOSレベルの依存ライブラリ(libnss3等)を
# 最初から含んでいるため、これをベースにすることで「Playwrightが動かない」問題を回避する。
# バージョンはpackage.jsonの playwright (^1.47.2) と合わせる(メジャー.マイナーを一致させること。
# ブラウザバイナリのバージョンとPlaywright本体のバージョンに乖離があると起動に失敗するため)。
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app

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
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
