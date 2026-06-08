# Playwright公式イメージ: Chromium実行に必要なOSレベルの依存ライブラリ(libnss3等)を
# 最初から含んでいるため、これをベースにすることで「Playwrightが動かない」問題を回避する。
# バージョンはpackage.jsonの playwright (^1.47.2) と合わせる(メジャー.マイナーを一致させること。
# ブラウザバイナリのバージョンとPlaywright本体のバージョンに乖離があると起動に失敗するため)。
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# 依存関係を先にインストールしてレイヤーキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

# Prisma Clientの生成 + TypeScriptのビルド
RUN npx prisma generate
RUN npm run build

# 起動時にDBマイグレーションを反映してからサーバーを起動する
# (migrate dev ではなく、本番向けの migrate deploy を使う)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
