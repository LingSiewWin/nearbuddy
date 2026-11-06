// Phone checks for the duel, agent and /how pages: no sideways scroll, one h1, no "undefined" or "NaN" in the
// text, the detail drawer takes focus and gives it back, and the server's first frame carries the facts.
// Ids and keys come from the live API (like smoke.spec.ts), so a run needs the network.
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

type Side = { verified: boolean };
type Recent = { duel: number; a: Side; b: Side };

async function ids(request: APIRequestContext) {
  const arena = await (await request.get("/api/v1/arena")).json();
  const recent = arena.recent as Recent[];
  const resolved = (recent.find((d) => d.a.verified && d.b.verified) ?? recent[0])?.duel;
  expect(resolved, "a resolved duel").toBeDefined();
  return {
    live: (arena.live_duels?.[0] as number | undefined) ?? resolved,
    resolved: resolved as number,
    agent: arena.standings[0]?.agent as string,
  };
}

/** Waits for the page's own h1 (not the loading frame), then checks width, headings and text. */
async function check(page: Page, path: string) {
  await page.goto(path);
  // while the server streams, the loading frame's h1 and the page's can both be in the DOM for a moment
  await expect(page.locator("main h1").filter({ hasNotText: /^Reading / })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("h1")).toHaveCount(1);
  const { sw, cw, text } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    text: document.body.innerText,
  }));
  expect(sw, `${path} scrolls sideways`).toBeLessThanOrEqual(cw);
  expect(text, `${path} prints a missing value`).not.toMatch(/\bundefined\b|\bNaN\b/);
}

test("duel pages fit a phone: live, resolved and one from the published record", async ({ page, request }) => {
  const { live, resolved } = await ids(request);
  const old = (await (await request.get("/api/v1/decisions?attacked=1&limit=1")).json()).rows[0]?.duel;
  for (const id of [live, resolved, old].filter((x) => x != null)) await check(page, `/duel/${id}`);
});

test("agent pages fit a phone: the top agent and a test bot", async ({ page, request }) => {
  const { agent } = await ids(request);
  const board = (await (await request.get("/api/arena")).json()).leaderboard as { pk: string; tee: boolean }[];
  const bot = board.find((a) => !a.tee)?.pk;
  for (const pk of [agent, bot].filter(Boolean) as string[]) await check(page, `/agent/${encodeURIComponent(pk)}`);
});

test("/how fits a phone and links its proof", async ({ page }) => {
  await check(page, "/how");
  await expect(page.locator(".how-lines a[href^='/duel/']").first()).toBeVisible();
  await expect(page.locator(".how-lines a[href*='nearblocks.io/txns/']")).toHaveCount(1);
});

test("the drawer focuses Close on a verified call and Esc gives focus back", async ({ page, request }) => {
  const { resolved, agent } = await ids(request);
  await page.goto(`/duel/${resolved}`);
  const seal = page.locator(".trail button.seal").first();
  await expect(seal).toBeVisible({ timeout: 45_000 });
  await seal.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toHaveAccessibleName("Verified decision");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(seal).toBeFocused();

  await page.goto(`/agent/${encodeURIComponent(agent)}`);
  const follow = page.locator("button.ag-cta");
  await expect(follow).toBeVisible({ timeout: 45_000 });
  await follow.click();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
});

test("without JavaScript the first frame has the result and the proof links", async ({ request }) => {
  const { resolved, agent } = await ids(request);
  const duel = await (await request.get(`/duel/${resolved}`)).text();
  expect(duel).toMatch(/won duel \d+|Level: /);
  expect(duel).toContain("testnet.nearblocks.io/txns/");
  const ag = await (await request.get(`/agent/${encodeURIComponent(agent)}`)).text();
  expect(ag).toContain(agent);
  expect(ag).toContain("Its record");
  expect(await (await request.get("/how")).text()).toContain("five-minute duels");
});
