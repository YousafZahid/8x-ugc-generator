/**
 * Turns a product URL into whatever we can learn about it.
 *
 * Three tiers, tried in order, because the demo has to survive a URL nobody
 * tested against:
 *
 *   1. direct fetch + cheerio  - OG tags, meta, headings, body text
 *   2. r.jina.ai               - free, keyless reader that renders JS-only
 *                                pages and often walks straight past a soft block
 *   3. the domain name itself  - always works, and a brand name plus the user's
 *                                own sentence is usually enough to brief from
 *
 * Tier 3 is the point of the whole file. A dead scrape must never fail a
 * render; it just produces a less specific video.
 */

import * as cheerio from "cheerio";

import type { Product } from "./types";

const TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS ?? 8000);
const MAX_TEXT = 4000;

/** A real browser UA. Plenty of marketing sites 403 anything that looks scripted. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Pulls the first http(s) URL out of free text, tolerating bare domains. */
export function extractUrl(message: string): string | null {
  const explicit = message.match(/https?:\/\/[^\s<>()"']+/i);
  if (explicit) return explicit[0].replace(/[.,;:!?]+$/, "");

  // Bare domains: "check out calai.app" - require a known-ish TLD shape so we
  // do not mistake "node.js" or "v1.2" for a site.
  const bare = message.match(
    /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s<>()"']*)?/i
  );
  if (!bare) return null;

  const host = bare[1].toLowerCase();
  // Filenames and version strings masquerading as domains.
  if (/\.(js|ts|tsx|json|md|py|sh|txt|png|jpg|mp4|css|html)$/i.test(host)) return null;
  if (/^\d+(\.\d+)*$/.test(host)) return null;

  return `https://${host}${bare[2] ?? ""}`.replace(/[.,;:!?]+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "calai.app" -> "Calai". Crude, but it only ever backs a total failure. */
function nameFromHost(host: string): string {
  const label = host.split(".")[0] ?? host;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function get(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // Timeout, DNS failure, TLS error, abort - all mean "try the next tier".
    return null;
  }
}

function absolutise(src: string | undefined, base: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

/** Extracts a Product from raw HTML. */
export function parseHtml(html: string, url: string): Omit<Product, "via"> {
  const $ = cheerio.load(html);
  const meta = (sel: string) => $(sel).attr("content")?.trim() || "";

  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim();

  const description =
    meta('meta[property="og:description"]') ||
    meta('meta[name="description"]') ||
    meta('meta[name="twitter:description"]') ||
    $("p").first().text().trim();

  const siteName = meta('meta[property="og:site_name"]');

  const image =
    absolutise(meta('meta[property="og:image"]') || undefined, url) ||
    absolutise(meta('meta[name="twitter:image"]') || undefined, url) ||
    absolutise($("img[src]").first().attr("src"), url);

  // Body text with the furniture stripped. Headings first - they carry the
  // value proposition far more reliably than paragraph soup.
  $("script, style, noscript, svg, nav, footer, header, form").remove();
  const headings = $("h1, h2, h3")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const paras = $("p, li")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 24);

  const text = [...headings, ...paras]
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .slice(0, MAX_TEXT);

  return {
    url,
    host: hostOf(url),
    title: title.slice(0, 200),
    description: description.slice(0, 500),
    siteName: siteName.slice(0, 120),
    image,
    text,
  };
}

/** Did we actually learn anything, or just get a shell? */
function isThin(p: Omit<Product, "via">): boolean {
  return p.title.length < 3 && p.description.length < 20 && p.text.length < 120;
}

/**
 * Parses r.jina.ai output. Returns null when the reader came back but has
 * nothing usable - it answers 200 even for pages it could not read, emitting
 * a CAPTCHA warning and an empty body, so length alone is not enough.
 */
export function parseReader(reader: string, url: string): Product | null {
  if (/requiring CAPTCHA|Warning: This page/i.test(reader)) return null;

  const host = hostOf(url);
  const titleLine = reader.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const body = reader
    .replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT);

  if (body.length < 120) return null;

  return {
    url,
    host,
    title: (titleLine || nameFromHost(host)).slice(0, 200),
    description: body.split("\n").find((l) => l.trim().length > 40)?.slice(0, 500) ?? "",
    siteName: "",
    image: null,
    text: body,
    via: "jina",
  };
}

export async function scrape(url: string): Promise<Product> {
  const host = hostOf(url);

  // Tier 1 - straight at the site.
  const html = await get(url);
  if (html) {
    const parsed = parseHtml(html, url);
    if (!isThin(parsed)) return { ...parsed, via: "og" };
  }

  // Tier 2 - Jina's reader. Free, no key, renders JS and sidesteps soft blocks.
  const reader = await get(`https://r.jina.ai/${url}`, { Accept: "text/plain" });
  const parsedReader = reader ? parseReader(reader, url) : null;
  if (parsedReader) return parsedReader;

  // Tier 3 - never fails. The brief stage can still work from a name.
  return {
    url,
    host,
    title: nameFromHost(host),
    description: "",
    siteName: "",
    image: null,
    text: "",
    via: "domain",
  };
}
