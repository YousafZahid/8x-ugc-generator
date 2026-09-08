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

import { availableVibes } from "./audio";
import { jsonCompletion } from "./llm";
import { VIBES, type Brief, type Product, type Vibe } from "./types";

/** On-screen copy has to fit big type on a phone. These are hard ceilings. */
const HOOK_MAX = 46;
const PAYOFF_MAX = 52;

/**
 * Built per call, not at module load, and the vibe list comes from the audio
 * manifest rather than a hardcoded enum. If the library and the prompt drift
 * apart, every lookup misses and the same default track plays on every video -
 * which is exactly what "AI picks the asset" must not mean.
 */
/**
 * The worked examples, separable so their effect can be A/B'd:
 * BRIEF_NO_EXAMPLES=1 reverts to the rules-only prompt.
 */
function examples(): string {
  if (process.env.BRIEF_NO_EXAMPLES) return "";
  return `
Worked examples. Match this register - the hook is a thought the viewer has
already had, not a product claim.

Input: a wearable that tracks recovery, strain and sleep.
{
  "name": "WHOOP",
  "category": "recovery wearable",
  "valueProp": "tracks your sleep and strain so you know when to push and when to rest",
  "audience": "people who train hard",
  "vibe": "hype",
  "hook": "training hard and still exhausted?",
  "payoff": "whoop tells you when to rest",
  "backgroundQuery": "person lifting weights gym",
  "stickerQuery": "muscle"
}

Input: a launcher that runs commands and scripts from a keyboard shortcut.
{
  "name": "Raycast",
  "category": "mac launcher",
  "valueProp": "runs your tools and scripts from one keyboard shortcut",
  "audience": "developers",
  "vibe": "clean",
  "hook": "still hunting through six apps?",
  "payoff": "one shortcut. everything.",
  "backgroundQuery": "person typing laptop desk",
  "stickerQuery": "keyboard"
}

Input: an app that logs meals from a photo.
{
  "name": "Cal AI",
  "category": "calorie tracking app",
  "valueProp": "logs a meal from one photo and gives you the macros",
  "audience": "people tracking what they eat",
  "vibe": "upbeat",
  "hook": "no idea what's actually in that?",
  "payoff": "snap it. macros in seconds.",
  "backgroundQuery": "person photographing food plate",
  "stickerQuery": "pizza"
}

Input: an app that rounds up spare change and invests it.
{
  "name": "Acorns",
  "category": "micro investing app",
  "valueProp": "rounds up your spare change and invests it automatically",
  "audience": "people who never started investing",
  "vibe": "playful",
  "hook": "waiting until you have enough to invest?",
  "payoff": "start with your spare change",
  "backgroundQuery": "person paying phone cafe",
  "stickerQuery": "money"
}`;
}

function systemPrompt(): string {
  const vibes = availableVibes();
  return `You are a short-form video producer who writes UGC-style ads for products.

You will be given whatever could be scraped from a product's website, plus the
message the user typed. Decide how to advertise it in an 8-second vertical video.

Return ONLY a JSON object with exactly these keys:
{
  "name":            product name as a person would say it, 1-4 words
  "category":        what it is, e.g. "calorie tracking app", 2-5 words
  "valueProp":       one plain sentence on what it does for someone. No hype.
  "audience":        who it is for, 2-6 words
  "vibe":            EXACTLY one of these, no other value: ${vibes.join(" | ")}
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
- Write like a person, not a brochure. Lowercase is fine. Be specific.
- Pick the vibe that genuinely fits this product's energy. Do not default to
  the first option; a sleep tracker and a trading app do not share a mood.
${examples()}`;
}

type RawBrief = Partial<Record<keyof Omit<Brief, "source">, unknown>>;

function str(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  const cleaned = v.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, max);
}

function toVibe(v: unknown, seed: string): Vibe {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  const usable = availableVibes();

  if ((VIBES as readonly string[]).includes(s)) {
    const vibe = s as Vibe;
    // Honour the model even if the library cannot serve that vibe - pickAudio
    // handles the miss, and the brief should record what was actually chosen.
    return vibe;
  }

  // Unusable value. Spreading across the library beats collapsing to one
  // default, which is what made every video sound identical.
  if (usable.length) {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return usable[(h >>> 0) % usable.length];
  }
  return "upbeat";
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
    system: systemPrompt(),
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
    vibe: toVibe(data.vibe, product.host),
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
