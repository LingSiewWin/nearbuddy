// The home page states what the product does. It does not describe its own state or apologise for it: limits are
// stated where the visitor decides something (the payment step, /enter, the dataset), not on the first page.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BANNED =
  /\b(demo|testnet|test network|test NEAR|no real value|no duel|recording|practice round|by the team|by the project|made by the project|own accounts)\b/i;

function shownCopy(path: string) {
  const src = readFileSync(path, "utf8");
  // comments are for developers; only what can reach the screen is checked
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\{\/\*|\*)/.test(line))
    .join("\n");
}

test("the home page's own copy has none of the hedging phrases", () => {
  const hit = shownCopy(join(import.meta.dir, "..", "home.tsx")).match(BANNED);
  expect(hit?.[0] ?? null).toBeNull();
});

test("the stack-reveal section's copy has none of the hedging phrases", () => {
  // Account ids may end in .testnet; ban the hedging words as prose, not the suffix in a mono label.
  const shown = shownCopy(join(import.meta.dir, "..", "ui", "stack-reveal.tsx")).replace(
    /\b[\w.-]+\.testnet\b/g,
    "[account]",
  );
  const hit = shown.match(BANNED);
  expect(hit?.[0] ?? null).toBeNull();
});
