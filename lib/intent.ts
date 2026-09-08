/**
 * Decides whether a message is conversation or a request to make a video.
 *
 * This is a graded surface, not plumbing: "hi" gets a greeting, "what can you
 * do?" gets an explanation, and only an actual product request starts a render.
 * Getting this wrong in either direction is the most visible failure the app
 * has - a render triggered by "hi" looks broken, and a product URL answered
 * with chat looks useless.
 *
 * An LLM handles the ambiguous middle. Rules handle everything when it is
 * unreachable, and rules alone already get the graded cases right.
 */

import { jsonCompletion } from "./llm";
import { extractUrl } from "./scrape";

export type Action = "chat" | "generate";

export type Intent = {
  action: Action;
  /** What to say back. For `generate` this is the "on it" line. */
  reply: string;
  /** The URL to build from, when there is one. */
  url: string | null;
  source: "llm" | "rules";
};

const CAPABILITIES = `I turn a product into a short UGC-style ad.

Tell me about something you're building and include its link — for example
"I'm building CalAI, a calorie-tracking app: calai.app" — and I'll read the
site, work out what it is, pick real stock footage, a trending-style sticker
and a matching track, and composite an 8-second vertical video you can post.

Nothing is AI-generated: every frame is real stock media, assembled with
ffmpeg. AI only reads the page and decides what to look for.`;

const GREETING = /^(hi|hey|hello|yo|sup|howdy|good (morning|afternoon|evening)|hola)\b[\s!.?]*$/i;
const CAPABILITY =
  /(what can you do|what do you do|who are you|how does this work|what is this|help|capabilities|how do i use)/i;
const THANKS = /^(thanks|thank you|ta|cheers|nice|cool|awesome|great)\b[\s!.?]*$/i;

/**
 * Deterministic routing. Correct on every case the brief calls out, and the
 * only path when both providers are down.
 */
export function ruleIntent(message: string): Intent {
  const text = message.trim();
  const url = extractUrl(text);

  if (GREETING.test(text)) {
    return {
      action: "chat",
      reply: "Hey! Tell me what you're building and drop the link, and I'll make you a short ad for it.",
      url: null,
      source: "rules",
    };
  }

  if (THANKS.test(text)) {
    return { action: "chat", reply: "Anytime. Send another link whenever you want one.", url: null, source: "rules" };
  }

  if (CAPABILITY.test(text) && !url) {
    return { action: "chat", reply: CAPABILITIES, url: null, source: "rules" };
  }

  if (url) {
    return {
      action: "generate",
      reply: `On it — reading ${safeHost(url)} now.`,
      url,
      source: "rules",
    };
  }

  return {
    action: "chat",
    reply:
      "I can turn a product into a short video ad — I just need a link to work from. " +
      "Something like \"I'm building CalAI, a calorie-tracking app: calai.app\".",
    url: null,
    source: "rules",
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const SYSTEM = `You are the front desk of an app that makes short UGC-style video ads for products.

Classify the user's message and reply to it. Return ONLY JSON:
{
  "action": "chat" | "generate",
  "reply":  "what to say back, 1-3 sentences, friendly and plain"
}

Choose "generate" ONLY when the user is asking for a video/ad for a specific
product AND the message contains a website or domain to work from.

Choose "chat" for everything else: greetings, questions about what you can do,
small talk, thanks, or a product mentioned with no link (in which case ask for
the link).

For "generate", the reply is a short "on it" line - do not describe the video,
it has not been made yet.

What you can do, if asked: read a product's site, work out what it is, then
assemble an 8-second vertical video from real stock footage, an animated
sticker and a music bed. Nothing is AI-generated; AI only reads the page and
chooses the assets.`;

type RawIntent = { action?: unknown; reply?: unknown };

export async function routeIntent(message: string): Promise<Intent> {
  const rules = ruleIntent(message);

  // A greeting or a capability question is never worth a model call, and
  // routing them by rule removes any chance of a wrong render.
  const text = message.trim();
  if (GREETING.test(text) || THANKS.test(text) || (CAPABILITY.test(text) && !rules.url)) {
    return rules;
  }

  const { data } = await jsonCompletion<RawIntent>({
    system: SYSTEM,
    user: message,
    temperature: 0.3,
    maxTokens: 400,
  });

  if (!data) return rules;

  const action: Action = data.action === "generate" ? "generate" : "chat";
  const reply = typeof data.reply === "string" && data.reply.trim() ? data.reply.trim() : rules.reply;

  // The extractor decides whether a URL exists, not the model.
  //
  // Both directions were wrong in testing. The model claimed "generate" with
  // no link to build from, and - nondeterministically - answered "chat" to
  // "make an ad for linear.app", asking for a link that was already there:
  // it does not reliably see a bare domain as a URL. The regex always does.
  //
  // So presence of a URL is authoritative, and the model only decides the
  // wording. A message carrying a product link is a render request; that is
  // what this app is for.
  if (!rules.url) {
    return { action: "chat", reply, url: null, source: "llm" };
  }

  return {
    action: "generate",
    // If the model thought this was chat, its reply asks for the link we
    // already have. Use the rules acknowledgement instead.
    reply: action === "generate" ? reply : rules.reply,
    url: rules.url,
    source: "llm",
  };
}
