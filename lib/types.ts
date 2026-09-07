export type Product = {
  url: string;
  title: string;
  price: string | null;
  description: string | null;
  brand: string | null;
  images: string[];
};

export type Beat = {
  /** What the voiceover says for this shot. One or two short sentences. */
  vo: string;
  /** Index into Product.images that this beat should show. */
  image: number;
};

export type VideoScript = {
  hook: Beat;
  benefits: Beat[];
  cta: Beat;
};

export type Progress = {
  step: "scrape" | "script" | "voice" | "render" | "done" | "error";
  detail: string;
};

/** Flattens a script into the ordered beat list the renderer consumes. */
export function beatsOf(s: VideoScript): Beat[] {
  return [s.hook, ...s.benefits, s.cta];
}
