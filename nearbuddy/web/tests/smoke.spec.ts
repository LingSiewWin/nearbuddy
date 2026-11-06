// Each page reads the arena contract over the public RPC, so a run needs the network; ids and keys come
// from /api/arena rather than fixtures. SHOT=1 also saves a 1440 px screenshot of the duel page to docs/.
import { expect, test } from "@playwright/test";

const box = (name: string) => `pre span.hi:text-is("${name}")`;

test("/ redirects to /arena: headline, standings, tape and the agent view", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/arena$/);
  await expect(page).toHaveTitle("live arena · NearBuddy");
  await expect(page.locator(".p-story h1")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Standings" })).toBeVisible();
  await expect(page.locator(".p-board a[href^='/agent/']").first()).toBeVisible();
  await expect(page.locator(".p-tape .rows .row").first()).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page).toHaveURL(/#agent$/);
  await expect(page.locator(".p-story .m .ep code", { hasText: "/api/v1/arena" })).toBeVisible();
});

test("/agent/<pk> renders the record box", async ({ page, request }) => {
  const snap = await (await request.get("/api/arena")).json();
  const pk = snap.leaderboard[0]?.pk as string;
  expect(pk).toBeTruthy();
  await page.goto(`/agent/${encodeURIComponent(pk)}`);
  await expect(page).toHaveTitle(`agent ${pk.slice(0, 8)}… · NearBuddy`);
  await expect(page.locator(box("record"))).toBeVisible();
  await expect(page.locator("body")).toContainText(pk.slice(0, 10));
});

test("/duel/<newest> renders the result and links both agents", async ({ page, request }) => {
  const snap = await (await request.get("/api/arena")).json();
  const id = Number(snap.config.next_duel) - 1;
  expect(id).toBeGreaterThanOrEqual(0);
  await page.goto(`/duel/${id}`);
  await expect(page).toHaveTitle(`duel #${id} · NearBuddy`);
  // resolved: "<model> won duel <id>." or "Level: ..."; still open: "<model> is winning.", "Dead heat." or waiting
  await expect(page.locator("main h1")).toHaveText(/won duel \d+\.|^Level|is winning\.|Dead heat\.|Waiting for/, {
    timeout: 30_000,
  });
  await expect(page.locator("a[href^='/agent/']").first()).toBeVisible({ timeout: 30_000 });
  if (process.env.SHOT) await page.screenshot({ path: "../docs/duel-page.png", fullPage: true });
});

test("/api/agent with a bad pk returns 400", async ({ request }) => {
  expect((await request.get("/api/agent?pk=nope")).status()).toBe(400);
  expect((await request.get("/api/duel?id=abc")).status()).toBe(400);
});
