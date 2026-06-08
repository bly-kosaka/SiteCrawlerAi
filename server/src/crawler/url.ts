// URL正規化: host相対パスへ統一。フラグメントは除去、クエリは保持。末尾スラッシュは正規化（ルート以外は除去）。

// 表示用ホスト名(DBのhost/labelやエクスポートファイル名に使う)を取得する。
// 正規表現でスキーム/パスを取り除くだけだと、`http://user:pass@example.com/` のような
// URLに対して `user:pass@example.com` を返してしまい、利用者へ「実際とは異なる紛らわしい
// ホスト名」を見せてしまう(クロール自体は new URL().hostname の正しい値に対して行われるため
// 実害は無いが、表示上のスプーフィングの材料になり得る)。
// new URL().hostname を使い、実際に接続するホスト名と表示を一致させる。
export function normalizeHost(input: string): string {
  try {
    return new URL(input.trim()).hostname;
  } catch {
    // 呼び出し元(manager.ts)では事前にURL形式のバリデーションを通している前提だが、
    // 不正な文字列が渡された場合に備えて安全側のフォールバックを残す。
    return input
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\/+$/, "");
  }
}

export function toPath(absoluteUrl: string, host: string): string | null {
  let u: URL;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return null;
  }
  if (u.hostname !== host) return null;
  let path = u.pathname + u.search; // フラグメント除去、クエリは保持
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";
  return path;
}

export function isExternal(absoluteUrl: string, host: string): boolean {
  try {
    const u = new URL(absoluteUrl);
    return u.hostname !== host;
  } catch {
    return true;
  }
}

export function resolveHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function slugifyId(path: string, used: Set<string>): string {
  let base = path === "/" ? "home" : path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  if (!base) base = "page";
  let id = base;
  let i = 2;
  while (used.has(id)) {
    id = `${base}-${i++}`;
  }
  used.add(id);
  return id;
}
