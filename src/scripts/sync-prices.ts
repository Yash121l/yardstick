import { loadConfig } from "../config.js";
import { loadEnv } from "../env.js";
import { OpenRouterProvider } from "../providers/openrouter.js";

/**
 * Prints current OpenRouter prices for the OpenRouter entries in models.yaml.
 *
 * It deliberately PRINTS rather than rewrites: prices are yours to own, and a
 * silent registry edit would change every historical cost comparison without
 * a diff to review.
 */
async function main(): Promise<void> {
  const root = process.cwd();
  loadEnv(root);
  const config = loadConfig(root);
  const entries = config.models.filter((m) => m.provider === "openrouter");

  if (entries.length === 0) {
    process.stdout.write("No openrouter entries in models.yaml — nothing to sync.\n");
    return;
  }

  const provider = new OpenRouterProvider();
  if (!provider.isConfigured()) {
    process.stderr.write(`${provider.envKey} not set.\n`);
    process.exit(1);
  }

  const pricing = new Map((await provider.fetchPricing()).map((p) => [p.id, p]));
  for (const e of entries) {
    const p = pricing.get(e.id);
    if (!p) {
      process.stdout.write(`# ${e.id}: NOT FOUND on OpenRouter\n`);
      continue;
    }
    const changed = p.priceIn !== e.priceIn || p.priceOut !== e.priceOut;
    process.stdout.write(
      `- id: ${e.id}\n  priceIn: ${p.priceIn.toFixed(4)}\n  priceOut: ${p.priceOut.toFixed(4)}` +
        `${changed ? `   # was ${e.priceIn}/${e.priceOut}` : "   # unchanged"}\n`,
    );
  }
  process.stdout.write("\nPaste the changed values into models.yaml yourself.\n");
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
