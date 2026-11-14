// The home page states what the product does. It does not describe its own state or apologise for it: limits are
// stated where the visitor decides something (the payment step, /enter, the dataset), not on the first page.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BANNED =
  /\b(demo|testnet|test network|test NEAR|no real value|no duel|recording|practice round|replayed|off chain|sim round|replay stream|by the team|by the project|made by the project|own accounts)\b/i;

/** Mode words that must not appear as visitor-facing copy (Tags, titles, CTAs, aria, notes). */
const MODE = /\b(replayed|off chain|sim round|replay stream)\b|\breplay\b(?![A-Za-z])/i;

function shownCopy(path: string) {
  const src = readFileSync(path, "utf8");
  // comments are for developers; only what can reach the screen is checked
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");
}

/** Drop imports and known code identifiers so `\breplay\b` checks visitor strings, not modules or state. */
function visitorCopy(path: string) {
  return shownCopy(path)
    .replace(/^\s*import\b.*$/gm, "")
    .replace(/\b(useReplay|ReplayRoom|ReplayActions|ReplayRecord|RECORDED|setReplay)\b/g, "[sym]")
    .replace(/\breplay\s*[:=]/g, "[sym]=")
    .replace(/\b!replay\b/g, "![sym]")
    .replace(/\breplay\s*\?/g, "[sym]?")
    .replace(/\bonReplay\b/g, "[sym]")
    .replace(/\b\[replay,\s*\[sym\]\]/g, "[sym]")
    .replace(/\bconst\s+\[replay\b/g, "const [[sym]");
}

test("the home page's own copy has none of the hedging phrases", () => {
  const shown = visitorCopy(join(import.meta.dir, "..", "home.tsx"));
  expect(shown.match(BANNED)?.[0] ?? null).toBeNull();
  expect(shown.match(MODE)?.[0] ?? null).toBeNull();
  // the chapter is named for what it is, not for the one duel playing in it
  expect(shown).toMatch(/title: "Arena"/);
  expect(shown).not.toMatch(/title: [^\n]*Duel #/);
  expect(shown).not.toMatch(/replayed/i);
});

test("the stack-reveal section's copy has none of the hedging phrases", () => {
  // Account ids may end in .testnet; ban the hedging words as prose, not the suffix in a mono label.
  const shown = visitorCopy(join(import.meta.dir, "..", "ui", "stack-reveal.tsx")).replace(
    /\b[\w.-]+\.testnet\b/g,
    "[account]",
  );
  expect(shown.match(BANNED)?.[0] ?? null).toBeNull();
});

test("the home try-a-headline panel's copy has none of the hedging phrases", () => {
  const shown = visitorCopy(join(import.meta.dir, "..", "ui", "practice.tsx"));
  expect(shown.match(BANNED)?.[0] ?? null).toBeNull();
  expect(shown.match(MODE)?.[0] ?? null).toBeNull();
  expect(shown).not.toMatch(/off chain/i);
});

test("the duel room's Stage / transport copy has none of the replay mode hedges", () => {
  const shown = visitorCopy(join(import.meta.dir, "..", "ui", "room.tsx"));
  expect(shown.match(MODE)?.[0] ?? null).toBeNull();
  expect(shown).not.toMatch(/>\s*replay\s*</i);
  expect(shown).not.toMatch(/Pause the replay|Play the replay|Position in the recording/i);
});

test("the ocean dock and audit visitor copy has none of the sim / replay hedges", () => {
  for (const file of ["duel-bet-dock.tsx", "audit-drawer.tsx"]) {
    const shown = visitorCopy(join(import.meta.dir, "..", "ui", "ocean", file));
    expect(shown.match(MODE)?.[0] ?? null).toBeNull();
    expect(shown).not.toMatch(/Sim stake|Run sim round|sim ticks|replay stream/i);
  }
});

test("/enter still states test NEAR where the visitor locks a bond", () => {
  const shown = shownCopy(join(import.meta.dir, "..", "enter", "enter.tsx"));
  expect(shown).toMatch(/test NEAR/i);
});
