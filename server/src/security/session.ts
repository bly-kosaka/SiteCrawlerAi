/* ============================================================
   サーバー側セッション管理。

   旧方式(固定値文字列を署名するだけのCookie)は偽造耐性こそあるものの、
   サーバー側に「真実」を持たないため以下ができなかった:
     - ログアウトで漏えい済みCookieを無効化する
     - アイドル/絶対の有効期限をサーバー側で強制する
     - 管理者が任意のセッションを強制失効する

   本モジュールはセッションをDB(既存のSQLite/Prisma)で管理することで、
   上記を可能にする。Redis等の追加インフラは導入しない
   (本ツールは単一インスタンス・小規模運用が前提であり、新たな
   運用対象を増やすコストの方が大きいと判断)。
   ============================================================ */
import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";

// アイドル期限: この時間アクセスが無いセッションは失効する
const IDLE_TTL_MS = 12 * 60 * 60 * 1000; // 12時間
// 絶対期限: アクセスし続けても、発行から この時間 が過ぎたセッションは失効する
// (漏えいしたセッションが無期限に使い続けられる事態を防ぐ)
const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
// lastSeenAt の更新頻度。リクエストの度にDB書き込みすると無駄が大きいため間引く
const TOUCH_INTERVAL_MS = 5 * 60 * 1000; // 5分

/**
 * 新しいセッションを発行しDBへ保存する。セッションIDは32バイトの暗号論的乱数
 * (base64url、43文字程度)。連番や予測可能な要素を含まない。
 */
export async function createSession(): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { id } });
  return id;
}

/**
 * セッションIDを検証する。有効なら lastSeenAt を(間引きながら)更新してtrueを返す。
 * 無効(存在しない/期限切れ)ならDBから削除しfalseを返す。
 */
export async function validateAndTouchSession(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return false;

  const now = Date.now();
  const expired =
    now - session.createdAt.getTime() > ABSOLUTE_TTL_MS ||
    now - session.lastSeenAt.getTime() > IDLE_TTL_MS;

  if (expired) {
    await deleteSession(sessionId);
    return false;
  }

  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return true;
}

/** セッションを即時失効させる(ログアウト、または漏えい時の強制失効に使用)。 */
export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

/**
 * 期限切れセッションの掃除。リクエスト経路の検証では「期限切れなら削除」を
 * 個別に行うため必須ではないが、長期間アクセスされなかったセッション
 * (検証されないまま残り続けるレコード)をDBに溜め込まないために定期実行する。
 */
export async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  await prisma.session.deleteMany({
    where: {
      OR: [
        { createdAt: { lt: new Date(now - ABSOLUTE_TTL_MS) } },
        { lastSeenAt: { lt: new Date(now - IDLE_TTL_MS) } },
      ],
    },
  });
}
