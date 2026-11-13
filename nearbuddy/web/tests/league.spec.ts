// The league home in a browser: it renders from the live keyless arena, something on the stage moves, and the cases a
// visitor can meet without doing anything wrong (no price, no match, one game, hostile text, a phone) read sanely.
// The first two tests need the network (RPC through the api routes, exchange candles); the rest stub the routes.
import { expect, type Page, test } from "@playwright/test";

const side = (model: string, s: "Long" | "Short") => ({
  pk: `${model}pk`,
  model,
  owner: "coach.testnet",
  side: s,
  size_bps: 5000,
  pnl: null,
});
/** A match open for the next five minutes, as /api/league would describe it. */
const liveMatch = () => ({
  id: "9",
  symbol: "wrap.near",
  open_at: `${(Date.now() - 60_000) * 1_000_000}`,
  close_at: `${(Date.now() + 300_000) * 1_000_000}`,
  open_price: "340000000",
  resolved: false,
  a: side("ModelA", "Long"),
  b: side("ModelB", "Short"),
  winner: null,
  attacks: 0,
});
const league = (over: Record<string, unknown>) => ({
  at: Date.now(),
  network: "testnet",
  contract: "arena.testnet",
  live: null,
  last: null,
  models: [],
  coaches: [],
  ...over,
});
const stub = (page: Page, url: string, body: unknown, status = 200) =>
  page.route(url, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));

test("renders the ticker, stage, feed and boards from the live arena; every board row says its games", async ({
  page,
}) => {
  await page.goto("/");
  for (const id of ["#ticker", "#stage", "#feed", "#boards"]) await expect(page.locator(id)).toBeVisible();
  // coaches: a model's board needs matches between two different models, which the arena may not have yet
  const rows = page.locator("#board-coaches tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  for (const text of await rows.allInnerTexts()) expect(text).toMatch(/\d+ games/);
});

test("something on the stage moves within 15 s", async ({ page }) => {
  await page.goto("/");
  const line = page.locator("#stage-line polyline");
  await expect(line).toHaveAttribute("points", /\d/, { timeout: 30_000 });
  const before = await line.getAttribute("points");
  await expect.poll(() => line.getAttribute("points"), { timeout: 15_000 }).not.toBe(before);
});

test("without a spot price a live match says so and shows no profit or rope", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/spot", { error: "coinbase 503" }, 502);
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("price unavailable");
  await expect(page.locator("#rope")).toHaveCount(0);
  await expect(page.locator("#stage")).not.toContainText("bps");
});

test("a live match with a price shows both sides' profit and the rope", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await page.route("**/api/spot", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ price: "3.4340", at: Date.now() }) }),
  );
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("+50.0 bps"); // (3.434 - 3.4) / 3.4 × 5000
  await expect(page.locator("#stage")).toContainText("-50.0 bps");
  await expect(page.locator("#rope")).toBeVisible();
});

test("a price that stops arriving goes stale, even when the server's clock runs ahead of the browser's", async ({
  page,
}) => {
  const ahead = Date.now() + 5 * 60_000; // one reading, stamped five minutes ahead, served over and over
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/spot", { price: "3.4340", at: ahead });
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("+50.0 bps");
  await expect(page.locator("#stage")).toContainText("price unavailable", { timeout: 15_000 });
  await expect(page.locator("#stage")).not.toContainText("bps");
  await expect(page.locator("#stage-line circle")).toHaveCount(0); // no dot and no number frozen on the line
  await expect(page.locator("#stage-line")).not.toContainText("3.4340");
});

test("a match past its close is not shown as live, whatever a stale league body says", async ({ page }) => {
  const m = liveMatch();
  await stub(page, "**/api/league", league({ live: { ...m, close_at: `${(Date.now() - 5_000) * 1_000_000}` } }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/spot", { price: "3.4340", at: Date.now() });
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("no match yet");
  await expect(page.locator("#stage")).not.toContainText("LIVE");
});

test("a side that has not called yet is waiting, and there is no rope", async ({ page }) => {
  const m = liveMatch();
  await stub(page, "**/api/league", league({ live: { ...m, a: { ...m.a, side: null, size_bps: null } } }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await page.route("**/api/spot", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ price: "3.4340", at: Date.now() }) }),
  );
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("waiting for call");
  await expect(page.locator("#stage")).toContainText("-50.0 bps");
  await expect(page.locator("#rope")).toHaveCount(0);
});

test("an empty arena says there is no match yet and logs no error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await stub(page, "**/api/league", league({}));
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("no match yet");
  await expect(page.locator("#board-models")).toContainText("no match between two different models yet");
  await expect(page.locator("#board-coaches")).toContainText("no finished match yet");
  expect(errors).toEqual([]);
});

test("markup in a model's reply or a shout shows as text and does not run", async ({ page }) => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/spot", { error: "x" }, 502);
  await stub(page, "**/api/league/feed*", {
    at: 0,
    duel: "9",
    lines: [
      { kind: "model", at: "1", model: "ModelA", side: "Long", size_bps: 1, text: hostile, tx: "t1" },
      { kind: "shout", at: "2", index: 0, by: "x.testnet", target: "A", text: hostile, arm: "Cue", outcome: "Pending" },
    ],
  });
  await page.goto("/");
  await expect(page.locator("#feed li.model")).toContainText(hostile);
  await expect(page.locator("#feed li", { hasText: "SHOUT" })).toContainText(hostile);
  expect(await page.locator("#feed img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("a model with one game is listed unranked, with no error shown", async ({ page }) => {
  const row = { key: "m", label: "ModelA", n: 1, mean: 4, se: null, w: 1, t: 0, l: 0, thin: true, group: 0 };
  await stub(page, "**/api/league", league({ models: [row] }));
  await page.goto("/");
  const tr = page.locator("#board-models tbody tr");
  await expect(tr).toContainText("not enough games");
  await expect(tr).toContainText("1 games");
  await expect(tr).not.toContainText("±");
  await expect(page.locator("#ticker")).toContainText("no model has enough games to rank yet");
});

test("ranks within error of each other share a rank and say so", async ({ page }) => {
  const row = (label: string, mean: number, group: number) => ({
    key: label,
    label,
    n: 40,
    mean,
    se: 3,
    w: 10,
    t: 20,
    l: 10,
    thin: false,
    group,
  });
  await stub(page, "**/api/league", league({ models: [row("ModelA", 5, 1), row("ModelB", 3, 1), row("ModelC", -20, 2)] }));
  await page.goto("/");
  await expect(page.locator("#board-models tbody tr td:first-child")).toHaveText(["1", "1", "2"]);
  await expect(page.locator("#board-models")).toContainText("the first 2 rows are within error of the leader");
});

test("phone width: no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#boards")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const DS = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const QW = "Qwen/Qwen3.8-27B";
const operator = (over: Record<string, unknown>) => ({
  available: true,
  busy: false,
  phase: "idle",
  duel: null,
  a: null,
  b: null,
  open_at: null,
  call_at: null,
  tick_at: null,
  close_at: null,
  error: null,
  models: [
    { id: DS, idle: true },
    { id: QW, idle: true },
  ],
  ...over,
});

test("with no operator there is no start panel", async ({ page }) => {
  await stub(page, "**/api/league", league({}));
  await stub(page, "**/api/league/start", { available: false });
  await page.goto("/");
  await expect(page.locator("#stage")).toContainText("no match yet");
  await expect(page.locator("#start")).toHaveCount(0);
});

test("the start panel lists the operator's models and posts the two chosen", async ({ page }) => {
  let posted: unknown = null;
  await stub(page, "**/api/league", league({}));
  await page.route("**/api/league/start", (r) => {
    if (r.request().method() === "POST") posted = r.request().postDataJSON();
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(operator(posted ? { busy: true, phase: "opening" } : {})),
    });
  });
  await page.goto("/");
  await page.locator("#start select").nth(0).selectOption(QW);
  await page.locator("#start select").nth(1).selectOption(DS);
  await page.locator("#start button").click();
  await expect(page.locator("#start")).toContainText("opening the match");
  expect(posted).toEqual({ a: QW, b: DS });
  await expect(page.locator("#start button")).toBeDisabled();
});

test("while a match is being watched the panel says when the models call, and cannot start another", async ({
  page,
}) => {
  await stub(page, "**/api/league", league({}));
  await stub(
    page,
    "**/api/league/start",
    operator({ busy: true, phase: "watching", duel: "9", open_at: Date.now(), call_at: Date.now() + 125_000 }),
  );
  await page.goto("/");
  await expect(page.locator("#start")).toContainText(/models call in 02:0\d/);
  await expect(page.locator("#start button")).toBeDisabled();
});

test("a refused start shows the operator's reason", async ({ page }) => {
  await stub(page, "**/api/league", league({}));
  await page.route("**/api/league/start", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: `no idle agent for ${QW}` }) })
      : r.fulfill({ contentType: "application/json", body: JSON.stringify(operator({})) }),
  );
  await page.goto("/");
  await page.locator("#start button").click();
  await expect(page.locator("#start")).toContainText(`no idle agent for ${QW}`);
});

test("with a live match and no wallet, the feed offers to connect one before a shout", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch(), shout_fee: "100000000000000000000000" }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/spot", { price: "3.4340", at: Date.now() });
  await page.goto("/");
  await expect(page.locator("#shout")).toContainText("0.100 NEAR");
  await expect(page.locator("#shout button")).toHaveText(/connect a wallet to shout/);
  await expect(page.locator("#shout input")).toHaveCount(0);
});

test("with no live match there is nothing to shout at", async ({ page }) => {
  await stub(page, "**/api/league", league({}));
  await page.goto("/");
  await expect(page.locator("#shout")).toContainText("shouts open when a match is live");
  await expect(page.locator("#shout button")).toHaveCount(0);
});

const comment = (id: string, at: number, by: string, text: string) => ({ id, at, by, text });

test("comments show in the feed in time order with the models' lines, as text", async ({ page }) => {
  const t = Date.now() - 60_000;
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/spot", { price: "3.4340", at: Date.now() });
  await stub(page, "**/api/league/session", { available: true, account: null });
  await stub(page, "**/api/league/feed*", {
    at: 0,
    duel: "9",
    lines: [{ kind: "model", at: `${(t + 10_000) * 1_000_000}`, model: "ModelA", side: "Long", size_bps: 1, text: "calling long", tx: "t1" }],
  });
  await stub(page, "**/api/league/comments*", {
    available: true,
    duel: "9",
    comments: [
      comment("c1", t, "early.testnet", "who opens first?"),
      comment("c2", t + 20_000, "late.testnet", '<img src=x onerror="window.__pwned=1">'),
    ],
  });
  await page.goto("/");
  await expect(page.locator("#feed ol li")).toHaveText([/early\.testnet.*who opens first\?/, /ModelA.*calling long/, /late\.testnet.*<img src=x/]);
  expect(await page.locator("#feed img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("without a session the chat offers to sign in and has no input", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/league/session", { available: true, account: null });
  await stub(page, "**/api/league/comments*", { available: true, duel: "9", comments: [] });
  await page.goto("/");
  await expect(page.locator("#chat button")).toHaveText(/sign in to comment/);
  await expect(page.locator("#chat input")).toHaveCount(0);
});

test("with a session a comment is posted for the shown match and appears", async ({ page }) => {
  let posted: unknown = null;
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/league/session", { available: true, account: "me.testnet" });
  await page.route("**/api/league/comments*", (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON();
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ comment: comment("c9", Date.now(), "me.testnet", "glm again") }) });
    }
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, duel: "9", comments: [] }) });
  });
  await page.goto("/");
  await page.locator("#chat input").fill("glm again");
  await page.locator("#chat input").press("Enter");
  await expect(page.locator("#feed ol li", { hasText: "glm again" })).toContainText("me.testnet");
  expect(posted).toEqual({ duel: "9", text: "glm again" });
  await expect(page.locator("#chat input")).toHaveValue("");
});

test("a refused comment shows the reason and keeps the text", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/league/session", { available: true, account: "me.testnet" });
  await page.route("**/api/league/comments*", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "one comment every 5 seconds" }) })
      : r.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, duel: "9", comments: [] }) }),
  );
  await page.goto("/");
  await page.locator("#chat input").fill("too fast");
  await page.locator("#chat input").press("Enter");
  await expect(page.locator("#chat")).toContainText("one comment every 5 seconds");
  await expect(page.locator("#chat input")).toHaveValue("too fast");
});

test("where comments are not set up there is no chat box", async ({ page }) => {
  await stub(page, "**/api/league", league({ live: liveMatch() }));
  await stub(page, "**/api/league/feed*", { at: 0, duel: "9", lines: [] });
  await stub(page, "**/api/league/session", { available: false, account: null });
  await stub(page, "**/api/league/comments*", { available: false, duel: "9", comments: [] });
  await page.goto("/");
  await expect(page.locator("#shout")).toBeVisible();
  await expect(page.locator("#chat")).toHaveCount(0);
});
