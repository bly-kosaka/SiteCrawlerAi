import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// SQLiteはデフォルトのジャーナルモード(DELETE)だと書き込み中に読み取りがブロックされ、
// クロール実行中(大量INSERT)にダッシュボードからの参照が詰まりやすい。
// WALモードは「読み取りは書き込みをブロックしない」ため、本アプリのような
// 単一プロセス・少数同時接続のワークロードに適している。
// 接続のたびに設定する必要はないが、PRAGMAはDB接続ごとの設定でありコネクションプール内の
// 各接続に確実に適用するため、起動時に一度実行しておく。
// PRAGMA journal_mode は設定後の値を行として返すため $queryRawUnsafe を使う
// ($executeRawUnsafe は「結果行を返さない」ことを前提としており SQLite ではエラーになる)。
await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
