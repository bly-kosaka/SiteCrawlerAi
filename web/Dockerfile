# ビルドステージ: Viteで静的ファイル一式を生成する。
# 重要: VITE_API_BASE は import.meta.env 経由でビルド時に成果物へ埋め込まれる
# (実行時の環境変数では反映されない)。そのためビルド時に --build-arg として
# 渡す必要がある。秘密情報ではない(バックエンドの公開URLを示すだけ)ため、
# ビルド成果物に含まれても問題はない。
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# 配信ステージ: 軽量な静的サーバー(serve)でSPAとして配信する。
# -s フラグにより、存在しないパスへのアクセスは index.html へフォールバックされる
# (ハッシュルーティングではなくパスベースのルーティングへ将来移行した場合に必要)。
FROM node:20-slim
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist

# RailwayはPORT環境変数を動的に注入するため、起動コマンド側で展開する
CMD ["sh", "-c", "serve -s dist -l ${PORT:-3000}"]
