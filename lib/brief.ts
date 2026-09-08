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
already had, not a product claim. Never reuse this copy; it is a register
guide, not a template.

Input: a subscription that ships running shoes twice a year.
{
  "name": "Stride",
  "category": "running shoe subscription",
  "valueProp": "sends you fresh running shoes before the old pair wears out",
  "audience": "regular runners",
  "vibe": "hype",
  "hook": "running on shoes from two years ago?",
  "payoff": "fresh pair, every season",
  "backgroundQueries": ["person running city street", "runner sunrise road"],
  "musicTags": ["phonk", "trap", "hiphop"],
  "stickerQueries": ["running shoe", "fire", "timer"]
}

Input: a password manager that fills logins across devices.
{
  "name": "Keyring",
  "category": "password manager",
  "valueProp": "stores every login and fills it in on any device",
  "audience": "anyone with too many accounts",
  "vibe": "clean",
  "hook": "resetting your password again?",
  "payoff": "one place for every login",
  "backgroundQueries": ["hands typing keyboard closeup", "person working laptop desk"],
  "musicTags": ["minimal", "techno", "ambient"],
  "stickerQueries": ["lock", "shield", "checkmark"]
}

Input: a meal kit that delivers pre-portioned dinner ingredients.
{
  "name": "Panfull",
  "category": "meal kit delivery",
  "valueProp": "delivers pre-portioned ingredients so dinner takes twenty minutes",
  "audience": "people who cook after work",
  "vibe": "upbeat",
  "hook": "staring into the fridge again?",
  "payoff": "dinner sorted in twenty minutes",
  "backgroundQueries": ["fresh ingredients chopping board", "person cooking kitchen evening"],
  "musicTags": ["funk", "soul", "indie"],
  "stickerQueries": ["cooking", "timer", "chef"]
}

Input: an invoicing tool for freelancers that chases late payments.
{
  "name": "Ledgerly",
  "category": "freelance invoicing",
  "valueProp": "sends your invoices and chases the ones that go unpaid",
  "audience": "freelancers",
  "vibe": "playful",
  "hook": "still waiting on that invoice?",
  "payoff": "it chases them so you don't",
  "backgroundQueries": ["freelancer working cafe laptop", "person paying phone"],
  "musicTags": ["lofi", "chillout", "jazz"],
  "stickerQueries": ["money", "invoice", "checkmark"]
}`;
}

export function systemPrompt(): string {
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
  "backgroundQueries": ARRAY of 2-3 stock footage searches, best first
  "musicTags":       ARRAY of 2-3 music GENRE tags for this ad, best first
  "stickerQueries":  ARRAY of 2-3 sticker search terms, best first
}

Rules that matter:
- The hook must stop a thumb. Speak to the problem, not the product. No brand
  name in the hook. No hashtags, no emoji, no quotation marks.
- The payoff names the product or the action. It is the reason to care.
- backgroundQueries must film the MOMENT THE HOOK DESCRIBES. The footage and
  the hook are on screen together, so they have to be about the same thing.
  If the hook is a frustration that happens on a screen ("tired of scrolling
  duplicate listings?"), film that screen moment - someone scrolling listings
  on a laptop. If the hook is about the thing itself ("still renting?"), film
  the thing - houses, a neighbourhood.
- Whichever you choose, the clip must contain the product's own subject
  matter. "Person at a laptop" on its own is generic stock filler that could
  sit under any product; "person scrolling property listings on a laptop"
  is specific and is fine. Name the subject in the query either way.
- Order them specific to broad, because a stock library may hold nothing for
  the narrow one: ["person scrolling property listings laptop",
  "modern house exterior", "real estate neighbourhood"]. Each must be
  something a camera can film - never abstractions like "productivity".
- musicTags name the genre that should play under THIS ad, judged from the
  product's niche and audience. Use real genre words a music library indexes:
  lofi, chillout, ambient, hiphop, trap, phonk, drumnbass, house, techno,
  minimal, synthwave, funk, soul, jazz, indie, rock, pop, cinematic,
  orchestral, acoustic. A recovery wearable is not the same as a meal kit.
  Do not name artists or songs.
- stickerQueries must convey what the product DOES, readable in half a second.
  Not the brand's mascot and not a literal noun from its name. A language app
  is "chat bubble", "globe", "waving hello", "flag" - not "owl". A password
  manager is "lock". Others that work: fire, money, timer, checkmark, muscle,
  rocket. Never a brand name. Give 2-3 so there is a fallback.
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

/**
 * Accepts an array, or a single string from a model that ignored the schema.
 *
 * maxLen is a parameter because this is shared by three fields with very
 * different shapes. It was fixed at 30, which suits a one-or-two-word sticker
 * term and silently discarded EVERY background query - "person scrolling
 * property listings laptop" is 42 characters - so footage fell back to the
 * heuristic theme table on every single render.
 */
function toQueries(v: unknown, fallback: string[], maxLen = 30): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const cleaned = raw
    .map((x) => (typeof x === "string" ? x.trim().replace(/^["']|["']$/g, "") : ""))
    .filter((x) => x.length > 1 && x.length <= maxLen)
    .slice(0, 3);
  return cleaned.length ? cleaned : fallback;
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
  // Word-bounded. Unanchored, /eat/ matched "Create" in the user's own
  // message and sent a property marketplace to food footage, and /game/
  // matched "playing a game" in Duolingo's meta description.
  const themes: [RegExp, string, string][] = [
    [/\b(calorie|diet|nutrition|food|meal|recipe|eating)\b/, "healthy food flat lay", "food"],
    [/\b(fitness|workout|gym|running|training)\b/, "person working out gym", "muscle"],
    [/\b(travel|flight|hotel|trip)\b/, "airplane window view", "airplane"],
    [/\b(finance|money|invest|investing|bank|budget|crypto)\b/, "person using phone cafe", "money"],
    [/\b(music|audio|podcast|sound)\b/, "person wearing headphones", "music"],
    [/\b(photo|camera|video|design|creative)\b/, "creative desk setup", "camera"],
    [/\b(videogame|gaming|esports)\b/, "gaming setup neon", "game controller"],
    [/\b(study|learn|learning|course|education|language)\b/, "student studying laptop", "books"],
    [/\b(shop|store|ecommerce|retail|fashion|clothing)\b/, "shopping bags street", "shopping"],
    [/\b(code|developer|software|api)\b/, "laptop screen code", "computer"],
    [/\b(pet|dog|cat)\b/, "dog running park", "dog"],
    [/\b(sleep|calm|meditation|wellness|mental)\b/, "calm morning bedroom", "sleep"],
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
    backgroundQueries: [backgroundQuery],
    stickerQueries: [stickerQuery, "sparkles"],
    musicTags: [],
    source: "fallback",
  };
}

/**
 * The exact text the model sees. Exported so it can be inspected: the sticker
 * and footage terms are only as good as this, and "what did the model actually
 * read?" should not require adding a print statement.
 */
export function briefContext(product: Product, message: string): string {
  return [
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
}

export async function buildBrief(
  product: Product,
  message: string
): Promise<{ brief: Brief; provider: string | null; ms: number; errors: string[] }> {
  const context = briefContext(product, message);

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
    backgroundQueries: toQueries(data.backgroundQueries, fb.backgroundQueries, 80),
    stickerQueries: toQueries(data.stickerQueries, fb.stickerQueries),
    musicTags: toQueries(data.musicTags, fb.musicTags),
    source: "llm",
  };

  return { brief, provider, ms, errors };
}
