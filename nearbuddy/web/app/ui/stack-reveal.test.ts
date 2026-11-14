// Stack reveal lists real NearBuddy integrations only — no fake team roster.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "stack-reveal.tsx"), "utf8");

test("stack reveal names the five NEAR integrations from the README", () => {
  for (const needle of [
    "NEAR AI Cloud enclave",
    "Arena contract on NEAR",
    "Chain Signatures",
    "Dataset",
    "MCP",
    "/evidence",
    "/board",
    "/llms.txt",
    "/api/mcp",
  ]) {
    expect(src.includes(needle)).toBe(true);
  }
});

test("stack reveal does not ship a fake creative-talent roster", () => {
  const shown = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\{\/\*|\*)/.test(line))
    .join("\n");
  expect(shown).not.toMatch(/unsplash|headshot|Creative Talent|ui\.aceternity|@\/components\/ui/i);
});
