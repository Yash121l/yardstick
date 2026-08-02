import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader. Existing process env always wins.
 *
 * Values are put straight into process.env and never echoed anywhere — no
 * logging, no masking-and-printing, no "first 4 chars" diagnostics.
 */
export function loadEnv(root: string): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") process.env[key] = value;
  }
}
