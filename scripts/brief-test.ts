/**
 * Scrape a URL and print the brief that would drive the render.
 *
 *   npm run brief -- "I'm building CalAI, a calorie app: calai.app"
 *   npm run brief -- --fallback "..."   # force the no-LLM path
 */

import { loadEnvLocal } from "../lib/env";

loadEnvLocal();

const forceFallback = process.argv.includes("--fallback");
if (forceFallback) {
  // Prove the deterministic path still ships something usable.
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
}

import { scrape, extractUrl } from "../lib/scrape";
import { buildBrief } from "../lib/brief";

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--fallback");
  if (!args.length) {
    console.error('usage: npm run brief -- [--fallback] "<message with a url>"');
    process.exit(1);
  }

  for (const message of args) {
    const url = extractUrl(message);
    if (!url) {
      console.log(`\n  ${JSON.stringify(message)} -> no URL; this is chat, not a render request`);
      continue;
    }

    const product = await scrape(url);
    const { brief, provider, ms, errors } = await buildBrief(product, message);

    console.log(
      `\n  ${url}   scrape=${product.via}   brief=${brief.source}` +
        `${provider ? ` via ${provider}` : ""}   ${ms}ms`
    );
    console.log(`    name        ${brief.name}`);
    console.log(`    category    ${brief.category}`);
    console.log(`    audience    ${brief.audience}`);
    console.log(`    vibe        ${brief.vibe}`);
    console.log(`    valueProp   ${brief.valueProp}`);
    console.log(`    HOOK        "${brief.hook}"  (${brief.hook.length} chars)`);
    console.log(`    PAYOFF      "${brief.payoff}"  (${brief.payoff.length} chars)`);
    console.log(`    background  ${brief.backgroundQueries.join(" / ")}`);
    console.log(`    stickers    ${brief.stickerQueries.join(" / ")}`);
    if (errors.length) console.log(`    errors      ${errors.join(" | ").slice(0, 240)}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
