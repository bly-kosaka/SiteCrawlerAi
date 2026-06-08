-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Crawl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "maxDepth" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "redirects" INTEGER NOT NULL DEFAULT 0,
    "orphans" INTEGER NOT NULL DEFAULT 0,
    "noindex" INTEGER NOT NULL DEFAULT 0,
    "dup" INTEGER NOT NULL DEFAULT 0,
    "dupH1s" INTEGER NOT NULL DEFAULT 0,
    "health" INTEGER NOT NULL DEFAULT 100,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
INSERT INTO "new_Crawl" ("active", "createdAt", "dup", "errors", "finishedAt", "health", "host", "id", "label", "maxDepth", "orphans", "pages", "redirects", "startUrl", "status", "truncated") SELECT "active", "createdAt", "dup", "errors", "finishedAt", "health", "host", "id", "label", "maxDepth", "orphans", "pages", "redirects", "startUrl", "status", "truncated" FROM "Crawl";
DROP TABLE "Crawl";
ALTER TABLE "new_Crawl" RENAME TO "Crawl";
CREATE INDEX "Crawl_createdAt_idx" ON "Crawl"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
