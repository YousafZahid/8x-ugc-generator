/**
 * Full pipeline, end to end, from the command line.
 *
 *   npm run generate -- "I'm building CalAI, a calorie app: calai.app"
 *
 * Writes a real mp4 and prints where it went, plus every decision that led
 * there. This is how a fresh URL gets vetted before it goes near a demo.
 */

import { loadEnvLocal } from "../lib/env";

loadEnvLocal();

import { generate } from "../lib/pipeline";
import { OUT_DIR } from "../lib/storage";

async function main() {
  const message = process.argv.slice(2).join(" ");
  if (!message) {
    console.error('usage: npm run generate -- "<message with a url>"');
    process.exit(1);
  }

  const r = await generate(message, (p) => console.log(`  [${p.step}] ${p.detail}`));

  console.log(`\n  BRIEF   (${r.brief.source})`);
  console.log(`    name        ${r.brief.name}`);
  console.log(`    vibe        ${r.brief.vibe}`);
  console.log(`    hook        "${r.brief.hook}"`);
  console.log(`    payoff      "${r.brief.payoff}"`);
  console.log(`    background  ${r.brief.backgroundQuery}`);
  console.log(`    sticker     ${r.brief.stickerQuery}`);

  console.log(`\n  ASSETS`);
  console.log(`    background  [${r.assets.background.source}] ${r.assets.background.credit}`);
  console.log(`    sticker     [${r.assets.sticker.source}] ${r.assets.sticker.credit}`);
  console.log(`    audio       [${r.assets.audio.source}] ${r.assets.audio.credit}`);

  if (r.notes.length) {
    console.log(`\n  NOTES`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  console.log(`\n  TIMING  scrape ${r.ms.scrape}ms | brief ${r.ms.brief}ms | assets ${r.ms.assets}ms | render ${r.ms.render}ms | total ${(r.ms.total / 1000).toFixed(1)}s`);
  console.log(`\n  VIDEO   ${OUT_DIR}/${r.id}.mp4`);
  console.log(`  URL     ${r.videoUrl}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
