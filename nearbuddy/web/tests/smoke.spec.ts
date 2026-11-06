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

test("/agent/<pk>: identity, the two numbers, its record, its calls and the agent view", async ({ page, request }) => {
  // ids come from the v1 summary: the raw /api/arena reads every oracle-era duel on a cold start
  const pk = (await (await request.get("/api/v1/arena")).json()).standings[0]?.agent as string;
  expect(pk).toBeTruthy();
  await page.goto(`/agent/${encodeURIComponent(pk)}`);
  await expect(page).toHaveTitle(`agent ${pk.slice(0, 8)}… · NearBuddy`);
  await expect(page.locator(".ag-hero h1")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ag-nums .ag-num")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Its record" })).toBeVisible();
  await expect(page.locator(".ag-duels a[href^='/duel/']").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Its calls, in its own words" })).toBeVisible();
  await expect(page.locator("body")).toContainText(pk.slice(0, 10));
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.locator(".ag-hero .m .ep code")).toHaveText(`/api/agent?pk=${encodeURIComponent(pk)}`);
  // every page's RSC payload carries the not-found text, so check the rendered heading and the status
  expect((await page.goto("/agent/not-a-key"))?.status()).toBe(404);
  await expect(page.locator("main h1")).toHaveText("Nothing here.");
});

test("/duel/<newest> renders the result and links both agents", async ({ page, request }) => {
  const id = Number((await (await request.get("/api/v1/arena")).json()).duels_total) - 1;
  expect(id).toBeGreaterThanOrEqual(0);
  await page.goto(`/duel/${id}`);
  await expect(page).toHaveTitle(`duel #${id} · NearBuddy`);
  // resolved: "<model> won duel <id>." or "Tie: ..."; still open: "<model> is winning.", "Dead heat." or waiting
  // while the server streams, the loading frame's h1 and a hidden copy of the page's can both be in the DOM
  const h1 = page.locator("main h1").filter({ hasNotText: /^Reading / });
  await expect(h1).toHaveText(/won duel \d+\.|^Tie|is winning\.|Dead heat\.|^Both bet (up|down)\.|^Both calls are sealed\.|no call revealed yet\.|^No winner|^No call revealed|Waiting for/, { timeout: 30_000 });
  await expect(page.locator("a[href^='/agent/']").first()).toBeVisible({ timeout: 30_000 });
  if (process.env.SHOT) await page.screenshot({ path: "../docs/duel-page.png", fullPage: true });
});

test("/api/agent with a bad pk returns 400", async ({ request }) => {
  expect((await request.get("/api/agent?pk=nope")).status()).toBe(400);
  expect((await request.get("/api/duel?id=abc")).status()).toBe(400);
});

test("a duel id or agent key that cannot exist is a real 404; its markdown twin a 400", async ({ request }) => {
  for (const path of ["/duel/abc", "/duel/-1", "/agent/not-a-key", "/agent/%E0%A4%A"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toMatch(/<h1[^>]*>Nothing here\.<\/h1>/); // the payload alone carries it as JSON
  }
  expect((await request.get("/duel/abc?format=md")).status()).toBe(400);
});
