// Loads the gitignored env file at the package root before any other module reads process.env.
// Import this FIRST in every entry point: ESM evaluates imports in order, so later modules that
// capture env values at init (chain.ts, oneclick.ts, arena.ts) see the file's values.
// Parsed by hand: `process.loadEnvFile` is missing under bun 1.3 and bun's own auto-load only covers
// the current working directory, so a script started from another folder would silently lose its env.
import { readFileSync } from "node:fs";

try {
  const text = readFileSync(new URL("../../../.env", import.meta.url).pathname, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] ??= v; // the shell still wins
  }
} catch {
  /* no env file: defaults apply */
}
