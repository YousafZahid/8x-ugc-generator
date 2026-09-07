/**
 * Small media introspection helpers, shared by the fixture generator, the
 * smoke test, and asset selection.
 *
 * Lives in lib/ rather than scripts/ so importing it cannot drag a script's
 * top-level side effects along with it.
 */

import sharp from "sharp";

/**
 * Counts pixels in the first frame whose alpha clears the visibility threshold.
 *
 * This exists because a Giphy "sticker" is not guaranteed to have usable alpha,
 * and a fully transparent overlay is invisible while remaining a perfectly
 * valid GIF: right dimensions, right frame count, bgra pixel format, and
 * nothing whatsoever on screen. Codec-level checks cannot see it.
 */
export async function opaquePixels(file: string): Promise<number> {
  try {
    const { data, info } = await sharp(file, { animated: false })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i] > 128) n++;
    return n;
  } catch {
    // Unreadable asset counts as unusable, which is what the caller acts on.
    return 0;
  }
}

/** Fraction of the first frame that is actually visible. */
export async function opaqueFraction(file: string): Promise<number> {
  try {
    const meta = await sharp(file, { animated: false }).metadata();
    const total = (meta.width ?? 0) * (meta.height ?? 0);
    if (!total) return 0;
    return (await opaquePixels(file)) / total;
  } catch {
    return 0;
  }
}
