import { request } from "undici";
import type { Browser, BrowserContext } from "playwright";
import { assertPublicHost, type HostPinCache } from "./ssrf.js";

export interface FetchResult {
  status: number;
  html: string;
  headers: Record<string, string>;
  ttfbMs: number;
}

export interface Fetcher {
  fetch(url: string): Promise<FetchResult>;
  close(): Promise<void>;
}

const USER_AGENT = "SiteMapperBot/1.0 (+internal SEO audit)";

// 高速モード: undici で GET するだけ（JSレンダリング無し）
export class FastFetcher implements Fetcher {
  constructor(private pinCache?: HostPinCache) {}

  async fetch(url: string): Promise<FetchResult> {
    // SSRF対策: DNSリバインディングを考慮し、接続直前に毎回ホストの解決先アドレスを検証する
    // （pinCache でクロール内の解決結果の変化も検知する。詳しくは ssrf.ts 参照）
    await assertPublicHost(new URL(url).hostname, this.pinCache);

    const start = performance.now();
    const res = await request(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT },
      maxRedirections: 0,
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
      await res.body.dump();
    } else {
      html = await res.body.text();
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

// レンダリングモード: Playwright(Chromium) でJSレンダリング後のHTMLを取得
export class RenderFetcher implements Fetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private pinCache?: HostPinCache) {}

  private async ensure() {
    if (this.browser) return;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ userAgent: USER_AGENT });
  }

  async fetch(url: string): Promise<FetchResult> {
    // SSRF対策: DNSリバインディングを考慮し、接続直前に毎回ホストの解決先アドレスを検証する
    // （pinCache でクロール内の解決結果の変化も検知する。詳しくは ssrf.ts 参照）
    await assertPublicHost(new URL(url).hostname, this.pinCache);

    await this.ensure();
    const page = await this.context!.newPage();
    try {
      const start = performance.now();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const ttfbMs = Math.round(performance.now() - start);
      if (!response) return { status: 0, html: "", headers: {}, ttfbMs };
      const status = response.status();
      const headers = response.headers();
      const html = status >= 300 && status < 400 ? "" : await page.content();
      return { status, html, headers, ttfbMs };
    } finally {
      await page.close();
    }
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
  }
}

export function createFetcher(render: boolean, pinCache?: HostPinCache): Fetcher {
  return render ? new RenderFetcher(pinCache) : new FastFetcher(pinCache);
}
