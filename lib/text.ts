/**
 * Text cards, drawn as SVG and rasterised to transparent PNG with sharp.
 *
 * Deliberately not ffmpeg's drawtext: escaping user-supplied copy into a
 * filter_complex is a footgun, drawtext cannot wrap, and it cannot do the
 * stroke-plus-shadow treatment that makes text readable over arbitrary
 * stock footage. SVG gives real typography for about the same effort.
 *
 * Wrapping is done by estimating advance width rather than measuring: there is
 * no text metrics API here, and for a heavy sans at these sizes the estimate is
 * within a few percent, which is all a centred block needs.
 */

import sharp from "sharp";

export type CardVariant = "hook" | "payoff";

export type CardSpec = {
  text: string;
  /** Small line above the headline, usually the product name. */
  kicker?: string;
  variant: CardVariant;
  width: number;
  height: number;
  /** Top of the text block as a fraction of height. Set by the layout preset. */
  top?: number;
  /** Absolute path to write to. */
  out: string;
};

/**
 * Font stack, not a single family. The container installs DejaVu; macOS
 * resolves Helvetica. Both are heavy neutral sans faces, so the layout maths
 * holds either way.
 */
const FONT = "Inter, 'DejaVu Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Mean advance width as a fraction of font-size, for a bold sans. */
const ADVANCE = 0.56;
const ADVANCE_UPPER = 0.62;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy wrap against an estimated pixel budget. Long single words are kept whole. */
function wrap(text: string, fontSize: number, maxWidth: number, upper: boolean): string[] {
  const advance = (upper ? ADVANCE_UPPER : ADVANCE) * fontSize;
  const budget = Math.max(1, Math.floor(maxWidth / advance));
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= budget || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Picks the largest font size that fits the copy in `maxLines`.
 * Short hooks come out huge, long ones step down instead of overflowing.
 */
function fit(text: string, width: number, upper: boolean, startSize: number, maxLines: number) {
  const maxWidth = width * 0.84;
  let size = startSize;
  for (let i = 0; i < 14; i++) {
    const lines = wrap(text, size, maxWidth, upper);
    if (lines.length <= maxLines) return { size, lines };
    size = Math.round(size * 0.92);
  }
  return { size, lines: wrap(text, size, maxWidth, upper).slice(0, maxLines) };
}

export type CardImage = {
  png: string;
  /** Y offset of the block within the frame. */
  y: number;
  width: number;
  height: number;
};

/**
 * Renders only the text block, not a full-frame transparent card.
 *
 * The cards are looped into video streams so they can alpha-fade, and a
 * full-frame 1080x1920 RGBA stream per card costs real encode time. The block
 * is roughly a third of the frame, and overlaying it at an offset is identical
 * on screen.
 */
export function buildSvg(spec: CardSpec): { svg: string; y: number; width: number; height: number } {
  const { width: W, height: H, variant } = spec;
  const upper = variant === "hook";
  const copy = upper ? spec.text.toUpperCase() : spec.text;

  const { size, lines } = fit(copy, W, upper, Math.round(W * 0.105), variant === "hook" ? 3 : 2);
  const lineHeight = Math.round(size * 1.12);
  const stroke = Math.max(4, Math.round(size * 0.13));

  // Position comes from the layout preset, not a constant: the sticker moves
  // with it, and the two must not collide.
  const blockTop = Math.round(H * (spec.top ?? 0.15));
  // The drop shadow and stroke bleed past the glyphs, so the block gets padding.
  const pad = Math.round(size * 0.55);
  const kickerSize = Math.round(size * 0.34);
  // Generous: the headline carries a heavy stroke plus a drop shadow, both of
  // which grow its visual box well past the type metrics.
  const kickerGap = spec.kicker ? Math.round(kickerSize * 3.0) : 0;
  const firstBaseline = kickerGap + size + pad;

  const tspans = lines
    .map((line, i) => {
      const y = firstBaseline + i * lineHeight;
      return `<text x="${W / 2}" y="${y}" class="hl">${escapeXml(line)}</text>`;
    })
    .join("\n    ");

  const kicker = spec.kicker
    ? `<text x="${W / 2}" y="${kickerSize + pad}" class="kick">${escapeXml(
        spec.kicker.toUpperCase()
      )}</text>`
    : "";

  const blockHeight = Math.min(
    H,
    Math.round(kickerGap + size + lines.length * lineHeight + pad * 2)
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${blockHeight}" viewBox="0 0 ${W} ${blockHeight}">
  <defs>
    <filter id="sh" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="${Math.round(size * 0.06)}" stdDeviation="${Math.round(
        size * 0.07
      )}" flood-color="#000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <style>
    .hl {
      font-family: ${FONT};
      font-size: ${size}px;
      font-weight: 800;
      letter-spacing: ${upper ? "-0.01em" : "-0.02em"};
      text-anchor: middle;
      fill: #ffffff;
      stroke: #000000;
      stroke-width: ${stroke}px;
      stroke-linejoin: round;
      paint-order: stroke fill;
      filter: url(#sh);
    }
    .kick {
      font-family: ${FONT};
      font-size: ${kickerSize}px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-anchor: middle;
      fill: #ffe14d;
      stroke: #000000;
      stroke-width: ${Math.max(3, Math.round(kickerSize * 0.16))}px;
      stroke-linejoin: round;
      paint-order: stroke fill;
    }
  </style>
  ${kicker}
    ${tspans}
</svg>`;

  return { svg, y: Math.min(blockTop, H - blockHeight), width: W, height: blockHeight };
}

/** Rasterises one card to a transparent PNG, with its placement. */
export async function textCardPng(spec: CardSpec): Promise<CardImage> {
  const { svg, y, width, height } = buildSvg(spec);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toFile(spec.out);
  return { png: spec.out, y, width, height };
}
