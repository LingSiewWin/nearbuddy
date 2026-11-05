// Loads the gitignored env file at the package root before any other module reads process.env.
// Import this FIRST in every entry point: ESM evaluates imports in order, so later modules that
// capture env values at init (chain.ts, oneclick.ts, arena.ts) see the file's values.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname);
} catch {
  /* no env file: defaults apply */
}
