-- CreateTable
CREATE TABLE "Crawl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "maxDepth" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "redirects" INTEGER NOT NULL DEFAULT 0,
    "orphans" INTEGER NOT NULL DEFAULT 0,
    "dup" INTEGER NOT NULL DEFAULT 0,
    "health" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Page" (
    "crawlId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "h1" TEXT NOT NULL DEFAULT '',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "parent" TEXT,
    "inLinks" INTEGER NOT NULL DEFAULT 0,
    "outLinks" INTEGER NOT NULL DEFAULT 0,
    "words" INTEGER NOT NULL DEFAULT 0,
    "size" INTEGER NOT NULL DEFAULT 0,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "canonical" TEXT NOT NULL DEFAULT 'self',
    "redirectTo" TEXT,
    "ttfbMs" INTEGER,
    "issues" TEXT NOT NULL DEFAULT '[]',

    PRIMARY KEY ("crawlId", "id"),
    CONSTRAINT "Page_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "crawlId" TEXT NOT NULL,
    "s" TEXT NOT NULL,
    "t" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    CONSTRAINT "Edge_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrawlError" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "crawlId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrawlError_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Crawl_createdAt_idx" ON "Crawl"("createdAt");

-- CreateIndex
CREATE INDEX "Page_crawlId_idx" ON "Page"("crawlId");

-- CreateIndex
CREATE INDEX "Page_crawlId_status_idx" ON "Page"("crawlId", "status");

-- CreateIndex
CREATE INDEX "Page_crawlId_parent_idx" ON "Page"("crawlId", "parent");

-- CreateIndex
CREATE INDEX "Edge_crawlId_idx" ON "Edge"("crawlId");

-- CreateIndex
CREATE INDEX "Edge_crawlId_s_idx" ON "Edge"("crawlId", "s");

-- CreateIndex
CREATE INDEX "Edge_crawlId_t_idx" ON "Edge"("crawlId", "t");

-- CreateIndex
CREATE INDEX "CrawlError_crawlId_idx" ON "CrawlError"("crawlId");
