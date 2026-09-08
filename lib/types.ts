/**
 * Shared shapes for the pipeline: page -> brief -> assets -> render.
 *
 * Replaces an earlier voiceover-ad scaffold. There is no TTS in this product:
 * the brief is prohibited from AI-generated media, so audio comes from a
 * committed royalty-free library and every visible pixel is a real asset.
 */

/** What we managed to learn from the product URL. Every field may be empty. */
export type Product = {
  url: string;
  host: string;
  title: string;
  description: string;
  siteName: string;
  /** Best hero image found on the page, if any. Used as a background fallback. */
  image: string | null;
  /** Trimmed page text, capped before it reaches an LLM. */
  text: string;
  /** How we got the content. "domain" means every fetch failed and we guessed. */
  via: "og" | "html" | "jina" | "domain";
};

/** The vibe vocabulary. Audio files are tagged with these; the LLM picks one. */
export const VIBES = ["upbeat", "chill", "hype", "playful", "cinematic", "clean"] as const;
export type Vibe = (typeof VIBES)[number];

/** The creative decision. Produced by an LLM, or by heuristics when none is reachable. */
export type Brief = {
  /** Product name as a human would say it. */
  name: string;
  /** e.g. "calorie tracking app" */
  category: string;
  /** One line, plain language, no marketing fluff. */
  valueProp: string;
  audience: string;
  vibe: Vibe;
  /** First text card. Short, punchy, scroll-stopping. */
  hook: string;
  /** Second text card. The payoff or CTA. */
  payoff: string;
  /** Search terms for Pexels. Concrete and filmable, not abstract. */
  backgroundQuery: string;
  /**
   * Two or three music genre tags for this specific product and ad, best
   * first. Vibe is a coarse bucket - six of them cannot tell a fintech ad from
   * a skincare ad - so the model names the genre directly.
   */
  musicTags: string[];
  /**
   * Two or three ranked sticker search terms, best first.
   *
   * A list rather than one string because a single bad word used to sink the
   * whole layer: there was no second chance and no way to compare across
   * options.
   */
  stickerQueries: string[];
  /** Where the brief came from, so the UI can be honest about it. */
  source: "llm" | "fallback";
};

/** One chosen asset plus the attribution we owe for it. */
export type Asset = {
  /** Local path on disk once downloaded. */
  path: string;
  /** Where it came from, for CREDITS and the UI. */
  source: "pexels" | "giphy" | "jamendo" | "local" | "fixture";
  credit: string;
  /** Canonical page for the asset, for attribution links. */
  link: string | null;
  /** Audio only: real length, so the mid-track offset can be bounded. */
  durationSeconds?: number;
  /** Audio only: already trimmed to a window, so the renderer starts at 0. */
  preTrimmed?: boolean;
  /** Audio only: where in the original track that window begins. */
  startOffset?: number;
};

export type AssetSet = {
  background: Asset;
  sticker: Asset;
  audio: Asset;
};

/** Progress stages, in the order the chat displays them. */
export type Step = "read" | "understand" | "assets" | "compose" | "done" | "error";

/** Ordered stage list the UI renders as a checklist. */
export const STEP_ORDER: Step[] = ["read", "understand", "assets", "compose"];

export type Progress = {
  step: Step;
  detail: string;
  /** Findings worth showing before the video exists. */
  meta?: {
    /** Product name, once the page has been read and understood. */
    product?: string;
    /** The hook, so the user sees the copy before the render lands. */
    hook?: string;
  };
};

export type RenderJob = {
  id: string;
  createdAt: number;
  status: Step;
  /** Everything emitted so far, so a reconnecting client can catch up. */
  events: Progress[];
  product?: Product;
  brief?: Brief;
  assets?: AssetSet;
  /** Public URL of the finished mp4, once there is one. */
  videoUrl?: string;
  /** Human-readable, never a raw stack trace. */
  error?: string;
};

/** A chat turn as the UI stores it. */
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  jobId?: string;
  videoUrl?: string;
};
