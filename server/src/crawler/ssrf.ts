// SSRF (Server-Side Request Forgery) 対策。
// クロール対象 URL はユーザー入力であり、クローラー（undici / Playwright）はそのホストへ
// 直接リクエストを発行する。検証無しでは localhost / プライベートIP / クラウドメタデータ
// (169.254.169.254 等) への到達を許してしまうため、実際に接続する直前に必ず検証する。
//
// DNSリバインディング対策として「ホスト名の解決結果（実際に接続するIP）」を検証する点が
// 重要であり、クロール開始時の一回限りのチェックでは TOCTOU で迂回され得る。
// そのため fetcher 側でも個々のリクエスト直前に再検証する（assertPublicHost は dns.lookup の
// OS/Node 側キャッシュにより十分高速）。
//
// 注意: この再検証自体も「検証用の名前解決」と「実際に接続する undici/Chromium が行う
// 名前解決」は別物であり、検証で得たIPに接続を固定（ピン留め）するものではない。
// 真にTOCTOUを閉じるには「検証済みIPへ直接接続する」実装が必要だが、undiciのカスタム
// dispatcher や Chromium の host-resolver-rules を要し、複雑さに見合わないと判断した。
// 代わりに HostPinCache で「同一クロール内で最初に観測した解決結果」を記録し、
// 以降の検証で値が変化した場合は DNS リバインディングの兆候とみなしてクロールを
// 即座に中断する（軽量な変化検知。完全な対策ではないが、攻撃者が応答を途中で
// 切り替える典型的な手口は検知できる）。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(host: string, reason: string) {
    super(`接続をブロックしました（SSRF対策）: ${host} — ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

// IPv4: プライベート / ループバック / リンクローカル / 予約済みレンジ
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 不正形式は安全側でブロック
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 ループバック
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 リンクローカル＋クラウドメタデータ(169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETFプロトコル予約
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 ベンチマーク用
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 マルチキャスト 〜 240.0.0.0/4 予約 〜 255.255.255.255 ブロードキャスト
  return false;
}

// IPv6: ループバック / リンクローカル / ユニークローカル / マルチキャスト / IPv4射影 等
function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // ループバック / 未指定
  if (v.startsWith("::ffff:")) {
    const v4 = v.slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // fe80::/10 リンクローカル
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7 ユニークローカル
  if (v.startsWith("ff")) return true; // ff00::/8 マルチキャスト
  if (v.startsWith("64:ff9b::")) return true; // NAT64
  if (v.startsWith("100::")) return true; // Discard-Only Address Block
  if (v.startsWith("2001:db8:")) return true; // ドキュメント用予約
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return true; // パース不能なものは安全側でブロック
}

// クラウドメタデータ等、IPでなくホスト名で到達可能な内部エンドポイント
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal", // GCP
  "metadata.goog",
]);

/**
 * ホスト名 → 解決済みIPアドレス一覧（ソート済み）。
 * クロール単位で生成し、検証のたびに渡すことで「最初に観測した解決結果」を記憶する。
 */
export type HostPinCache = Map<string, string[]>;

/**
 * ホスト名を解決し、解決結果（実際に接続されるIPアドレス）が
 * すべて「公開アドレス」であることを検証する。問題があれば SsrfBlockedError を投げる。
 *
 * pinCache を渡すと、同一ホストについて以前に観測した解決結果と比較し、
 * 値が変化していた場合は DNS リバインディングの兆候とみなしてブロックする
 * （ファイル先頭のコメント参照。完全なIPピン留めではないが軽量な変化検知として機能する）。
 */
export async function assertPublicHost(hostname: string, pinCache?: HostPinCache): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfBlockedError(hostname, "ホスト名が空");

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfBlockedError(hostname, "localhost");
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(hostname, "既知の内部メタデータホスト名");
  }

  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new SsrfBlockedError(hostname, "プライベート/予約済みIPアドレス");
    return;
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(hostname, "DNS解決に失敗");
  }
  if (!records.length) throw new SsrfBlockedError(hostname, "DNS解決結果が空");

  const addresses = records.map((r) => r.address).sort();
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new SsrfBlockedError(hostname, `解決先アドレスがプライベート/予約済み (${addr})`);
    }
  }

  if (pinCache) {
    const pinned = pinCache.get(host);
    if (pinned === undefined) {
      pinCache.set(host, addresses);
    } else if (pinned.length !== addresses.length || pinned.some((a, i) => a !== addresses[i])) {
      throw new SsrfBlockedError(
        hostname,
        `DNS解決結果がクロール開始時から変化しました（DNSリバインディングの可能性: ${pinned.join(",")} → ${addresses.join(",")}）`
      );
    }
  }
}

/**
 * クロール開始時の事前検証用ヘルパー。http(s) 以外のスキームも拒否する。
 * ここでの検証は「早期にユーザーへエラーを返す」ためのものであり、
 * DNSリバインディング対策としては不十分（fetcher 側の再検証が本命）。
 */
export async function assertSafeStartUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, "URLとして解釈できません");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(rawUrl, `サポートされていないスキーム (${u.protocol})`);
  }
  await assertPublicHost(u.hostname);
  return u;
}
