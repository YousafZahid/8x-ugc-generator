/**
 * Turns a scraped page into the creative decision: what to say on screen and
 * what footage, sticker and mood to go looking for.
 *
 * This is the only place an LLM does real work. It is not generating media -
 * the brief forbids that - it is reading a product page and casting the shoot.
 *
 * Falls back to heuristics whenever the model is unreachable, rate-limited, or
 * returns something unusable. The fallback is deliberately decent rather than
 * a placeholder: on a free tier it will run for real.
 */

import { jsonCompletion } from "./llm";
import { VIBES, type Brief, type Product, type Vibe } from "./types";

/** On-screen copy has to fit big type on a phone. These are hard ceilings. */
const HOOK_MAX = 46;
const PAYOFF_MAX = 52;

const SYSTEM = `You are a short-form video producer who writes UGC-style ads for products.

You will be given whatever could be scraped from a product's website, plus the
message the user typed. Decide how to advertise it in an 8-second vertical video.

Return ONLY a JSON object with exactly these keys:
{
  "name":            product name as a person would say it, 1-4 words
  "category":        what it is, e.g. "calorie tracking app", 2-5 words
  "valueProp":       one plain sentence on what it does for someone. No hype.
  "audience":        who it is for, 2-6 words
  "vibe":            one of: ${VIBES.join(", ")}
  "hook":            FIRST on-screen text. Max ${HOOK_MAX} characters.
  "payoff":          SECOND on-screen text. Max ${PAYOFF_MAX} characters.
  "backgroundQuery": 2-4 words for a STOCK FOOTAGE search
  "stickerQuery":    1-2 words for an animated STICKER search
}

Rules that matter:
- The hook must stop a thumb. Speak to the problem, not the product. No brand
  name in the hook. No hashtags, no emoji, no quotation marks.
- The payoff names the product or the action. It is the reason to care.
- backgroundQuery must describe something a camera can film: "person cooking
  breakfast", "city street night". Never abstractions like "productivity" or
  "innovation" - stock libraries return garbage for those.
- stickerQuery must be a concrete object or reaction that a looping sticker
  exists for: "pizza", "fire", "thumbs up", "money". Never a brand name.
- Write like a person, not a brochure. Lowercase is fine. Be specific.`;

type RawBrief = Partial<Record<keyof Omit<Brief, "source">, unknown>>;

function str(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  const cleaned = v.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, max);
}

function toVibe(v: unknown): Vibe {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  return (VIBES as readonly string[]).includes(s) ? (s as Vibe) : "upbeat";
}

/** Strips the boilerplate that clutters most <title> tags. */
function cleanTitle(title: string): string {
  return title
    .split(/[|–—\-·:]/)[0]
    .trim()
    .slice(0, 40);
}

/**
 * Heuristic brief. Runs when no LLM is reachable.
 *
 * Not a placeholder - this ships real videos, so it reads the scraped page
 * rather than emitting lorem ipsum.
 */
export function fallbackBrief(product: Product, message: string): Brief {
  // og:site_name is a brand name; <title> is often a whole sentence
  // ("Learn a language for free"), so prefer the former when present.
  const name =
    (product.siteName && cleanTitle(product.siteName)) ||
    cleanTitle(product.title) ||
    product.host.split(".")[0];
  const sentence =
    product.description.split(/(?<=[.!?])\s/)[0]?.trim() ||
    product.text.split("\n").find((l) => l.trim().length > 30)?.trim() ||
    "";

  const valueProp = sentence.slice(0, 140) || `${name} — see what it does.`;

  // Pull a filmable noun out of what we know, or fall back to something
  // universally safe that still looks like real footage.
  const haystack = `${message} ${product.title} ${product.description}`.toLowerCase();
  const themes: [RegExp, string, string][] = [
    [/calorie|diet|nutrition|food|meal|recipe|eat/, "healthy food flat lay", "food"],
    [/fitness|workout|gym|run|training/, "person working out gym", "muscle"],
    [/travel|flight|hotel|trip/, "airplane window view", "airplane"],
    [/finance|money|invest|bank|budget|crypto/, "person using phone cafe", "money"],
    [/music|audio|podcast|sound/, "person wearing headphones", "music"],
    [/photo|camera|video|design|creative/, "creative desk setup", "camera"],
    [/game|gaming|play/, "gaming setup neon", "game controller"],
    [/study|learn|course|education|language/, "student studying laptop", "books"],
    [/shop|store|ecommerce|retail|fashion|clothing/, "shopping bags street", "shopping"],
    [/code|developer|software|api|dev tool/, "laptop screen code", "computer"],
    [/pet|dog|cat/, "dog running park", "dog"],
    [/sleep|calm|meditat|wellness|mental/, "calm morning bedroom", "sleep"],
  ];

  let backgroundQuery = "person using phone";
  let stickerQuery = "sparkles";
  for (const [re, bg, sticker] of themes) {
    if (re.test(haystack)) {
      backgroundQuery = bg;
      stickerQuery = sticker;
      break;
    }
  }

  return {
    name: name.slice(0, 40),
    category: "",
    valueProp,
    audience: "",
    vibe: "upbeat",
    hook: str(sentence, HOOK_MAX) || `you need to see this`,
    payoff: `${name} — try it today`.slice(0, PAYOFF_MAX),
    backgroundQuery,
    stickerQuery,
    source: "fallback",
  };
}

export async function buildBrief(
  product: Product,
  message: string
): Promise<{ brief: Brief; provider: string | null; ms: number; errors: string[] }> {
  const context = [
    `URL: ${product.url}`,
    `Scrape tier: ${product.via}${product.via === "domain" ? " (site unreachable - work from the name and the user's message)" : ""}`,
    product.title && `Page title: ${product.title}`,
    product.siteName && `Site name: ${product.siteName}`,
    product.description && `Meta description: ${product.description}`,
    product.text && `Page text:\n${product.text.slice(0, 2500)}`,
    `\nThe user said: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, provider, ms, errors } = await jsonCompletion<RawBrief>({
    system: SYSTEM,
    user: context,
    temperature: 0.85,
    maxTokens: 700,
  });

  if (!data) {
    return { brief: fallbackBrief(product, message), provider: null, ms, errors };
  }

  const fb = fallbackBrief(product, message);
  const brief: Brief = {
    name: str(data.name, 40, fb.name),
    category: str(data.category, 60, fb.category),
    valueProp: str(data.valueProp, 160, fb.valueProp),
    audience: str(data.audience, 60, fb.audience),
    vibe: toVibe(data.vibe),
    hook: str(data.hook, HOOK_MAX, fb.hook),
    payoff: str(data.payoff, PAYOFF_MAX, fb.payoff),
    // A model that ignores the "filmable" rule poisons the whole video, so an
    // empty or abstract query falls back rather than reaching Pexels.
    backgroundQuery: str(data.backgroundQuery, 60, fb.backgroundQuery),
    stickerQuery: str(data.stickerQuery, 30, fb.stickerQuery),
    source: "llm",
  };

  return { brief, provider, ms, errors };
}
