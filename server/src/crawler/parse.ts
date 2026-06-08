import * as cheerio from "cheerio";
import { resolveHref } from "./url.js";

export type LinkType = "nav" | "footer" | "context";

export interface ExtractedLink {
  absoluteUrl: string;
  type: LinkType;
}

export interface ParsedPage {
  title: string;
  h1: string;
  noindex: boolean;
  canonical: string | null; // absolute URL or null
  words: number;
  sizeKb: number;
  links: ExtractedLink[];
}

// <nav>/header 内 → nav, <footer> 内 → footer, それ以外の本文 → context
function classifyLinkType($el: cheerio.Cheerio<any>): LinkType {
  if ($el.closest("nav, header").length) return "nav";
  if ($el.closest("footer").length) return "footer";
  return "context";
}

export function parseHtml(html: string, pageUrl: string, xRobotsTag?: string | null): ParsedPage {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();
  const h1 = $("h1").first().text().trim();

  const metaRobots = ($('meta[name="robots"]').attr("content") || "").toLowerCase();
  const noindex = metaRobots.includes("noindex") || (xRobotsTag || "").toLowerCase().includes("noindex");

  const canonicalHref = $('link[rel="canonical"]').attr("href") || null;
  const canonical = canonicalHref ? resolveHref(canonicalHref, pageUrl) : null;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const words = bodyText ? bodyText.split(" ").length : 0;
  const sizeKb = Math.round(Buffer.byteLength(html, "utf8") / 1024);

  const links: ExtractedLink[] = [];
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href) return;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href.trim())) return;
    const absoluteUrl = resolveHref(href, pageUrl);
    if (!absoluteUrl) return;
    links.push({ absoluteUrl, type: classifyLinkType($el) });
  });

  return { title, h1, noindex, canonical, words, sizeKb, links };
}
