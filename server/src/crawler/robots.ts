import { request } from "undici";
import { assertPublicHost, SsrfBlockedError, type HostPinCache } from "./ssrf.js";
import { FETCH_TIMEOUT_MS, MAX_BODY_BYTES, readBodyLimited } from "./fetcher.js";

interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
  // pattern をパース時に1回だけコンパイルしたもの（判定のたびに new RegExp しないため）
  regex: RegExp;
}

interface RobotsRules {
  rules: RobotsRule[];
  sitemaps: string[];
}

/**
 * origin → robots.txt の解析結果。
 *
 * 旧実装ではこのキャッシュをモジュールスコープ(プロセス全体)で共有していたが、
 * これは「あるクロールでSSRF検証を通過したoriginの結果が、後続の別クロールでも
 * 再利用される」= DNSが書き換わっていても再検証(assertPublicHost / HostPinCache)を
 * 素通りしてしまう経路になり得た。
 * クロールのたびに呼び出し側(engine.ts)で新しい Map を生成して渡すことで、
 * 「クロールを跨いだキャッシュ共有」を断ち、毎回のクロール開始時には
 * 必ず assertPublicHost による検証が実行されるようにする。
 */
export type RobotsCache = Map<string, RobotsRules | null>;

// robots.txt の path パターンを正規表現へ変換する。
// `*` は任意の文字列に、末尾の `$` はURL終端アンカーとして扱う(Googleの仕様に準拠)。
function patternToRegex(pattern: string): RegExp {
  const endsWithDollar = pattern.endsWith("$");
  const body = endsWithDollar ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + (endsWithDollar ? "$" : ""));
}

async function fetchRobots(origin: string, cache: RobotsCache, pinCache?: HostPinCache, signal?: AbortSignal): Promise<RobotsRules | null> {
  if (cache.has(origin)) return cache.get(origin)!;
  let result: RobotsRules | null = null;
  try {
    // SSRF対策: robots.txt の取得も実際にネットワーク接続を行うリクエストであるため、
    // fetcher.ts の通常クロールパスと同様に接続直前でホストを検証する
    // （pinCacheでDNSリバインディングの変化検知も適用する。詳しくは ssrf.ts 参照）。
    // これを怠ると、ここだけがSSRF対策の素通りルートになってしまう。
    await assertPublicHost(new URL(origin).hostname, pinCache);
    // 応答しないサーバーで最初のページ取得前に止まり続けないよう、通常の取得と同じタイムアウトを設ける
    const res = await request(`${origin}/robots.txt`, {
      method: "GET",
      headersTimeout: FETCH_TIMEOUT_MS,
      bodyTimeout: FETCH_TIMEOUT_MS,
      signal,
    });
    if (res.statusCode !== 200) {
      // 本文を読み残すと接続が解放されないため、使わない本文も必ず破棄する
      await res.body.dump();
    } else {
      // 上限を超える robots.txt は先頭から上限までを解析する（Google も上限以降の内容を無視する仕様）。
      // 途中で切れた最終行は誤ったパターンになり得るため捨てる。
      const body = await readBodyLimited(res.body, res.headers["content-length"], MAX_BODY_BYTES, "truncate");
      let text = body.text;
      if (body.truncated) {
        text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
        console.warn(`[robots] ${origin} の robots.txt が上限を超えたため先頭 ${MAX_BODY_BYTES} バイトまでを解析します`);
      }
      const rules: RobotsRule[] = [];
      const sitemaps: string[] = [];
      let applies = false;
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (/^user-agent:\s*\*/i.test(line)) applies = true;
        else if (/^user-agent:/i.test(line)) applies = false;
        else if (/^sitemap:/i.test(line)) {
          // Sitemap ディレクティブはユーザーエージェントグループに依存せずファイル全体に適用される
          const url = line.split(":").slice(1).join(":").trim();
          if (url) sitemaps.push(url);
        } else if (applies && /^(disallow|allow):/i.test(line)) {
          const m = line.match(/^(disallow|allow):\s*(.*)$/i)!;
          const pattern = m[2].trim();
          // 空の Disallow: は「全許可」を意味する慣習があるため、ルールとして登録しない
          if (pattern) rules.push({ type: m[1].toLowerCase() as "allow" | "disallow", pattern, regex: patternToRegex(pattern) });
        }
      }
      result = { rules, sitemaps };
      if (sitemaps.length) {
        console.log(`[robots] ${origin} の robots.txt から ${sitemaps.length} 件の Sitemap を検出:`, sitemaps);
      }
    }
  } catch (err) {
    // SSRFブロック（DNSリバインディング検知含む）は「robots.txtが無かった」とは別物で、
    // クロール対象ホストの安全性に関わるためキャッシュに通常結果として残さず、
    // クロール全体を中断できるよう呼び出し元へ伝播する
    if (err instanceof SsrfBlockedError) throw err;
    result = null;
  }
  cache.set(origin, result);
  return result;
}

// 最長一致したルールを優先する(Googleの仕様)。同じ長さの場合は Allow を優先する。
function isAllowedByRules(path: string, rules: RobotsRule[]): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!rule.regex.test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.type === "allow")
    ) {
      best = rule;
    }
  }
  return !best || best.type === "allow";
}

export async function isAllowedByRobots(
  origin: string,
  path: string,
  respect: boolean,
  cache: RobotsCache,
  pinCache?: HostPinCache,
  signal?: AbortSignal
): Promise<boolean> {
  if (!respect) return true;
  const robots = await fetchRobots(origin, cache, pinCache, signal);
  if (!robots) return true;
  return isAllowedByRules(path, robots.rules);
}

