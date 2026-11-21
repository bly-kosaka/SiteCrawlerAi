import { request } from "undici";
import { assertPublicHost, type HostPinCache } from "./ssrf.js";

// 1回の HTTP 取得の上限。応答しない/極端に遅いサーバーや巨大な応答で
// ワーカーが無期限に止まったり、本文全体をメモリに読み込んでヒープを圧迫したりしないようにする。
// headersTimeout: リクエスト送信から応答ヘッダー受信完了までの待ち時間の上限
// bodyTimeout   : 本文受信中に次のデータが届くまでの待ち時間の上限（本文全体の受信時間ではない）
export const FETCH_TIMEOUT_MS = 30_000;
// 本文の最大サイズ。これを超える応答は本文を読まずに（または読み始めた分を捨てて）破棄する。
export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// 本文が MAX_BODY_BYTES を超えたことを表すエラー。
// 再取得しても結果は変わらないため、engine 側ではリトライの対象外にする。
export class ResponseTooLargeError extends Error {
  constructor(public readonly limitBytes: number, detail: string) {
    super(`応答本文が上限(${Math.round(limitBytes / 1024 / 1024)}MB)を超えたため取得を中止しました (${detail})`);
    this.name = "ResponseTooLargeError";
  }
}

// undici の応答本文（Readable）の最小限の型
interface BodyLike extends AsyncIterable<Buffer | Uint8Array> {
  destroy(err?: Error): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * 本文を最大 limit バイトまで読み込んで UTF-8 文字列にする（res.body.text() と同じデコード）。
 * - Content-Length が limit を超えると分かっている場合は1バイトも読まずに本文を破棄する
 * - 読み込み途中で limit を超えた場合は、onOverflow が "throw" なら ResponseTooLargeError を投げ、
 *   "truncate" なら limit までに読んだ分だけを返す
 * いずれの場合も読み残しの本文は destroy して接続を確実に解放する（読み残したまま放置すると
 * ソケットがプールに戻らず、GC されるまで接続とバッファが残り続けるため）。
 */
function noop() {}

export async function readBodyLimited(
  body: BodyLike,
  contentLength: string | string[] | undefined,
  limit: number,
  onOverflow: "throw" | "truncate"
): Promise<{ text: string; truncated: boolean }> {
  // undici の本文ストリームは、読み終える前に destroy() すると RequestAbortedError を 'error' として emit する。
  // リスナーが無いと未処理の 'error' イベントとしてプロセスごと落ちるため、先に握りつぶすリスナーを付けておく
  // （undici の dump() と同じ対処）。読み込み中のエラーは for await 側で例外として受け取れるので情報は失われない。
  body.on("error", noop);
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (Number.isFinite(declared) && declared > limit) {
    body.destroy();
    if (onOverflow === "throw") throw new ResponseTooLargeError(limit, `Content-Length=${declared}`);
    return { text: "", truncated: true };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buf.length > limit) {
        if (onOverflow === "throw") throw new ResponseTooLargeError(limit, `受信 ${total + buf.length} バイト時点`);
        chunks.push(buf.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } finally {
    // for await を break / throw で抜けた場合もストリームは破棄されるが、
    // 読み込み完了後に呼んでも無害なので、取りこぼしが無いよう明示的に破棄しておく
    body.destroy();
  }
  return { text: Buffer.concat(chunks, total).toString("utf8"), truncated };
}

export interface FetchResult {
  status: number;
  html: string;
  headers: Record<string, string>;
  ttfbMs: number;
}

export interface FetchOptions {
  // 中断用シグナル。クロールのキャンセル・時間上限到達時に進行中の取得を速やかに止めるために使う
  signal?: AbortSignal;
}

export interface Fetcher {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
  close(): Promise<void>;
}

const USER_AGENT = "SiteMapperBot/1.0 (+internal SEO audit)";

// undici で GET するだけ（JSレンダリングは行わない）
export class FastFetcher implements Fetcher {
  constructor(private pinCache?: HostPinCache) {}

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    // SSRF対策: DNSリバインディングを考慮し、接続直前に毎回ホストの解決先アドレスを検証する
    // （pinCache でクロール内の解決結果の変化も検知する。詳しくは ssrf.ts 参照）
    await assertPublicHost(new URL(url).hostname, this.pinCache);
    opts.signal?.throwIfAborted();

    const start = performance.now();
    const res = await request(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT },
      maxRedirections: 0,
      headersTimeout: FETCH_TIMEOUT_MS,
      bodyTimeout: FETCH_TIMEOUT_MS,
      signal: opts.signal,
    });
    const ttfbMs = Math.round(performance.now() - start);

    // HTML以外のレスポンス（PDF・画像等のメディアファイル、WP REST APIのJSON/XML応答等）は
    // 文字列化やcheerioでのHTML解析の対象にしない。
    // Content-Typeを見ずに本文全体を文字列化してしまうと、
    //   ・同一オリジンのメディアファイル（wp-content/uploads配下のPDF/画像等）を
    //     バイナリのままUTF-8文字列として読み込みメモリを浪費する
    //   ・JSON/XML応答（例: /wp-json/oembed/...が返すoEmbed HTMLを含むJSON）を
    //     cheerioが緩く解析し、本来存在しないURLを<a href>として誤検出してしまい、
    //     クロール対象URLが際限なく増殖する
    // といった問題（WordPressサイトでクロールが完了しなくなる主要因）につながるため、
    // Content-TypeがHTMLであることを確認できた場合のみ本文を読み込む。
    const contentType = String(res.headers["content-type"] ?? "");
    const isHtml = /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
    let html = "";
    if (isRedirect || !isHtml) {
      // 本文は使わないため読まずに破棄する。dump() は既定で 128KB までを読み捨てて
      // 接続を再利用可能にし、それを超える場合は接続ごと破棄するため、巨大なメディアファイルでも
      // 本文全体を受信・保持することはない。
      await res.body.dump();
    } else {
      // 5MB を超える HTML は解析対象にせず取得エラーとして扱う（engine 側で CrawlError に記録される）。
      // 先頭 5MB だけを解析する方式も考えられるが、途中で切れた HTML から得た title/リンク/語数は
      // 実際のページと食い違い、それと気付けない形で監査結果に混ざってしまうため採らない。
      html = (await readBodyLimited(res.body, res.headers["content-length"], MAX_BODY_BYTES, "throw")).text;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
    }
    return { status: res.statusCode, html, headers, ttfbMs };
  }
  async close() {}
}

// 以前は Playwright(Chromium) で JS レンダリング後の HTML を取得するモード（RenderFetcher）もあったが、
// UI から指定する手段が無く、本番の実行環境では機能していなかった（全ページ取得失敗になる）うえ、
// Chromium の同梱がイメージサイズとメモリを圧迫していたため撤去した。取得は常に FastFetcher で行う。
export function createFetcher(pinCache?: HostPinCache): Fetcher {
  return new FastFetcher(pinCache);
}
