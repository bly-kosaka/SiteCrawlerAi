-- AlterTable
-- ページ一覧でメタディスクリプションを表示できるようにするため、Pageテーブルに description 列を追加する。
ALTER TABLE "Page" ADD COLUMN "description" TEXT NOT NULL DEFAULT '';
