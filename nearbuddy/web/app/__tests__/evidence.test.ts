// Research (/evidence): pin the lab fractions, keep lab vs on-chain apart, and forbid a false stranger-LIVE tag.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "..", "evidence", "page.tsx"), "utf8");
const drawer = readFileSync(join(import.meta.dir, "..", "evidence", "method-drawer.tsx"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "ui", "ui.css"), "utf8");
const globals = readFileSync(join(import.meta.dir, "..", "globals.css"), "utf8");
const instruments = readFileSync(join(import.meta.dir, "..", "ui", "instruments.tsx"), "utf8");

/** Drop // comments so developer notes are not mistaken for visitor copy. */
function shown(src: string) {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

test("Research pins the six lab fractions and the on-chain sample", () => {
  for (const frac of ["676, 704", "674, 704", "128, 707", "49, 705", "58, 713", "5, 45"]) {
    expect(page).toContain(frac);
  }
  expect(page).toMatch(/676\s*\/\s*704|676 of 704/);
  expect(page).toMatch(/49 of 705/);
  expect(page).toMatch(/5 of 45/);
  // on-chain sample
  expect(page).toMatch(/>\s*58\s*</);
  expect(page).toMatch(/>\s*23\s*</);
  expect(page).toMatch(/>\s*12\s*</);
  expect(page).toMatch(/>\s*11\s*</);
  expect(drawer).toContain("676/704");
  expect(drawer).toContain("58 placed, 23 decided, 12 fooled, 11 held");
});

test("Research uses sharp rectangular MeterBars, not ASCII density strips", () => {
  expect(page).toMatch(/MeterBar/);
  expect(page).not.toMatch(/AsciiStrip|asciiStripChars|ASCII_DENSITY/);
  expect(instruments).not.toMatch(/ASCII_DENSITY|AsciiStrip/);
  expect(css).toMatch(/\.meter-bar\s*\{/);
  expect(css).toMatch(/border-radius:\s*0/);
  expect(css).not.toMatch(/\.ascii-strip/);
});

test("Research has one method drawer and no per-chart Show-as-table / The data links", () => {
  expect(page).toMatch(/MethodDrawer/);
  expect(shown(page)).not.toMatch(/Show as table|The data/);
  expect(drawer).toMatch(/prompt_digest/);
  expect(drawer).toMatch(/model_type/);
  expect(drawer).toMatch(/flipped/);
  expect(drawer).toMatch(/enclave_sig/);
  expect(drawer).toMatch(/className="frost"/);
});

test("Finding 4 is on-chain, not a false live / stranger-play tag", () => {
  const copy = shown(page);
  expect(copy).toMatch(/kind="ink">on-chain</);
  expect(copy).not.toMatch(/kind="live">live</);
  expect(copy).toMatch(/all made by the team/);
  expect(copy).not.toMatch(/strangers (have )?played|anyone can attack live/i);
  expect(copy).toMatch(/On-chain attacks so far are few/);
});

test("Research colours stay on approved tokens — no teal/amber / #F9F9FB brand island", () => {
  expect(globals).toMatch(/#06070f/);
  expect(globals).toMatch(/#c6f432/);
  expect(globals).toMatch(/#6f8cff/);
  expect(globals).toMatch(/#ff3d7f/);
  expect(css).toMatch(/\.meter-bar\.alert \.meter-bar-fill\s*\{\s*background:\s*var\(--signal\)/);
  expect(css).toMatch(/dialog\.sheet\.frost/);
  // evidence-specific CSS must not invent teal/amber brand hex (bound to this block only)
  const start = css.indexOf("/* Research meters:");
  const end = css.indexOf(".spark {", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const evidenceCss = css.slice(start, end);
  expect(evidenceCss).toContain("dialog.sheet.frost");
  expect(evidenceCss).toContain("border-radius: 0");
  expect(evidenceCss).not.toMatch(/#0d9488|#14b8a6|#f59e0b|#fbbf24|#F9F9FB/i);
});
