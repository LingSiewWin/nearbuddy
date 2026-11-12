// No-stake predictions on the terminal at / against fixture data: /api/* is stubbed in the browser, and a fixture wallet is
// injected the way a browser-extension wallet announces itself to NEAR Connect (`near-wallet-injected`), so the page's
// own wallet code runs and the test reads the exact transaction the page asks it to sign. Covers every state: no
// wallet (the click connects first), an open market with its crowd split, a closed market, a settled one right and
// wrong with the claim, and both steering labels. SHOT_DIR=<dir> saves screenshots there.
import { expect, type Page, test } from "@playwright/test";

const PK_A = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const PK_B = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";
const PROOF = "3q2+7wAAAAD+7wAAAAD+7wAAAAD+7wAAAAD+7wAAAAA=";
const PREDICT = "nb-predict-v3-1111.testnet";
const ME = "spectator.testnet";
const NS = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const now = Date.now();

const intent = (pk: string, side: "Long" | "Short") => ({
  agent_pk: pk,
  duel_id: "480",
  side,
  size_bps: 5000,
  nonce: "7",
  expires_at: NS(now),
  proof_hash: PROOF,
});
const chaos = (headline: string, outcome: string) => ({
  arm: "Cue",
  at: NS(now - 5_000),
  claimed: false,
  decided_by: null,
  headline,
  injector: "bob.testnet",
  kind: "Short",
  next: null,
  outcome,
  payout: "0",
  prev: "Long",
  stake: "120000000000000000000000",
  target: PK_B,
});
const live = {
  id: "480",
  a: PK_A,
  b: PK_B,
  symbol: "wrap.near",
  open_at: NS(now - 60_000),
  close_at: NS(now + 240_000),
  pool: "100000000000000000000000",
  injections: [],
  resolved: false,
  last_intent_a: intent(PK_A, "Long"),
  last_intent_b: intent(PK_B, "Long"),
  open_price: "370000000",
  chaos: [chaos("Exchange hot wallet drained", "Held"), chaos("Binance delists NEAR at midnight", "Pending")],
  chaos_fee: "156250000000000000000000",
};
const arena = {
  at: now,
  contract: "arena.nearbuddy-solver.testnet",
  config: {
    next_duel: "481",
    min_chaos_deposit: "100000000000000000000000",
    commit_reveal: true,
    chaos: { base: "100000000000000000000000", cap: "1000000000000000000000000", fee_bps: 500, r_bps: 12500, share_bps: 5000 },
  },
  leaderboard: [
    { owner: "s.testnet", pk: PK_A, model_id: "z-ai/glm-5.3-flash", bond: "1", alpha_bps: 0, shield: 0, in_duel: "480", tee: true },
    { owner: "s.testnet", pk: PK_B, model_id: "Qwen/Qwen3.8-27B", bond: "1", alpha_bps: 0, shield: 0, in_duel: "480", tee: true },
  ],
  duels: [live],
  solver: null,
};
type Market = {
  duel_id: string;
  index: number | null;
  picks: { pick: string; n: number }[];
  total: number;
  scored: number;
  settled: boolean;
  outcome: string | null;
  steered_by: string | null;
  open_until_reveal: boolean;
  open: boolean;
};
const market = (index: number | null, n: number[], extra: Partial<Market> = {}): Market => ({
  duel_id: "480",
  index,
  picks: (index === null ? ["A", "B", "Tie"] : ["Flipped", "Held"]).map((pick, i) => ({ pick, n: n[i] ?? 0 })),
  total: n.reduce((a, b) => a + b, 0),
  scored: 0,
  settled: false,
  outcome: null,
  steered_by: null,
  open_until_reveal: false,
  open: true,
  ...extra,
});
/** The deployed arena has no `chaos_open`: a pending attack's market closes at the reveal, labelled so. */
const OPEN = [market(null, [5, 2, 0]), market(0, [1, 1], { open: false }), market(1, [3, 2], { open_until_reveal: true })];

type Held = { duel_id: string; index: number | null; pick: string; at: string; verdict: string | null }[];
/** Stubs every API the terminal reads; `markets` and `held` are read per request, so a test can change them. */
async function stub(page: Page, markets: () => Market[], held: () => Held = () => []) {
  await page.route("**/api/arena", (r) => r.fulfill({ json: arena }));
  await page.route("**/api/board", (r) => r.fulfill({ json: { source: "fixture", rows: 0, models: [], recent: [] } }));
  await page.route("**/api/flips", (r) => r.fulfill({ json: { at: now, flips: [], saboteurs: [], scanned: null } }));
  await page.route("**/api/spot", (r) => r.fulfill({ json: { symbol: "NEAR/USD", price: "3.7111", at: Date.now() } }));
  await page.route("**/api/predict?**", (r) => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get("duel") === "480") return r.fulfill({ json: { at: Date.now(), duel_id: "480", markets: markets() } });
    if (q.get("account") === ME)
      return r.fulfill({ json: { at: Date.now(), account: ME, held: held(), owed: "1410000000000000000000" } });
    return r.fulfill({ status: 400, json: { error: `unexpected ${q}` } });
  });
  // NEAR Connect's wallet list: none, so the fixture wallet is the only one offered
  await page.route("**/manifest.json", (r) => r.fulfill({ json: { wallets: [], version: "1.0.0" } }));
}

declare global {
  interface Window {
    __sent: { receiverId: string; actions: unknown[] }[];
  }
}
/** A wallet announced the way an extension wallet does; it records what it is asked to sign and answers with a
 *  successful outcome (a claim returns 2 deposits less the 0.00141 NEAR board row, as the contract would). `connected`:
 *  a previous visit selected it, so the page finds the account without a click. */
async function fixtureWallet(page: Page, connected: boolean) {
  await page.addInitScript(
    ([account, connected]) => {
      window.__sent = [];
      let signedIn: string | null = connected ? account : null;
      const accounts = () => (signedIn ? [{ accountId: signedIn, publicKey: "ed25519:11111111111111111111111111111111" }] : []);
      const wallet = {
        manifest: {
          id: "fixture-wallet",
          name: "Fixture Wallet",
          icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
          description: "test",
          website: "https://example.com",
          version: "1.0.0",
          executor: "",
          type: "injected",
          permissions: {},
          features: { testnet: true, signAndSendTransaction: true },
        },
        signIn: async () => {
          signedIn = account;
          return accounts();
        },
        signOut: async () => {
          signedIn = null;
        },
        getAccounts: async () => accounts(),
        signAndSendTransaction: async (p: { receiverId: string; actions: unknown[] }) => {
          window.__sent.push({ receiverId: p.receiverId, actions: p.actions });
          const claim = (p.actions[0] as { params?: { methodName?: string } }).params?.methodName === "claim";
          const SuccessValue = claim ? btoa(JSON.stringify("6790000000000000000000")) : "";
          return { transaction: { hash: "FixtureTx11111111111111111111111111111111111" }, status: { SuccessValue }, receipts_outcome: [] };
        },
      };
      if (connected) localStorage.setItem("selected-wallet", "fixture-wallet");
      window.addEventListener("near-selector-ready", () =>
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })),
      );
    },
    [ME, connected] as const,
  );
}
const shot = async (page: Page, name: string) => {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png`, fullPage: true });
};
const pane = (page: Page, n: number) => page.locator(`#pane-${n}`);
/** A pane's words with the box drawing and the line wrapping taken out, so a wrapped note reads as one sentence. */
const words = (page: Page, n: number) => async () =>
  (await pane(page, n).innerText()).replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ");
/** Every box line is as wide as its top border. */
const exactWidths = async (page: Page) => {
  const widths = await page.$$eval(".box", (boxes) =>
    boxes.map((b) => [...b.querySelectorAll(":scope > .ln:not(.slot), :scope > .item > .ln")].map((l) => (l.textContent ?? "").length)),
  );
  for (const w of widths) expect(new Set(w).size).toBe(1);
};

test.describe("desktop 1280", () => {
  test.use({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });

  test("no wallet: the split and the steering labels; a click explains, connects, then signs the page's predict", async ({
    page,
  }) => {
    let held: Held = [];
    await stub(page, () => OPEN, () => held);
    await fixtureWallet(page, false);
    await page.goto("/terminal");
    const duelCalls = pane(page, 2).getByRole("button", { name: /^predict (A|B) wins, no stake/ });
    await expect(duelCalls).toHaveText(["[A 71%]", "[B 29%]"]);
    await expect(duelCalls.first()).toHaveAccessibleName("predict A wins, no stake, 71% say so; connects a NEAR wallet first");
    await expect(pane(page, 2)).toContainText("who wins? no stake");
    const p2 = words(page, 2);
    await expect.poll(p2).toContain("71% say A wins");
    await expect.poll(p2).toContain(
      "a click connects a NEAR wallet · 0.0041 NEAR deposit back once scored, less up to 0.0014 NEAR once for your board row; gas applies",
    );
    // a duel market is never blind, and the deployed arena's chaos markets close at the reveal: both say so
    await expect.poll(p2).toContain("whoever drives either agent can steer this: it picks which replies get signed");
    await expect.poll(p2).toContain("closes at the reveal: whoever runs the agent knows the answer first");
    // the pending attack, in pane 2 and in the tail; the decided one has no buttons
    for (const n of [2, 3])
      await expect(pane(page, n).getByRole("button", { name: /^predict it will (be fooled|hold), no stake/ })).toHaveText([
        "[fooled 60%]",
        "[holds 40%]",
      ]);
    await expect(pane(page, 2).getByRole("button", { name: /^predict/ })).toHaveCount(4);
    // no stake before paid: who wins sits above the next attack's price and the inject buttons
    const freeY = (await duelCalls.first().boundingBox())!.y;
    expect(freeY).toBeLessThan((await pane(page, 2).getByText("next attack").boundingBox())!.y);
    expect(freeY).toBeLessThan((await pane(page, 2).getByRole("button", { name: "[inject A]" }).boundingBox())!.y);
    await exactWidths(page);
    await shot(page, "predict-open-1280");

    await duelCalls.first().click();
    await expect(page.locator("#cmdline")).toHaveValue("predict 480 A"); // the click types its command
    await expect(page.locator(".status")).toContainText("connect a NEAR testnet wallet: it signs your prediction");
    const picker = page.locator(".hot-connector-popup");
    await expect(picker.getByText("Fixture Wallet")).toBeVisible();
    held = [{ duel_id: "480", index: null, pick: "A", at: "1", verdict: null }];
    await picker.getByText("Fixture Wallet").click();
    await expect(page.locator(".status")).toContainText("predicted duel #480: A wins · tx FixtureTx1");
    expect(await page.evaluate(() => window.__sent)).toEqual([
      {
        receiverId: PREDICT,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "predict",
              args: { duel_id: "480", index: null, pick: "A" },
              gas: "60000000000000",
              deposit: "4100000000000000000000",
            },
          },
        ],
      },
    ]);
    await expect(pane(page, 2)).toContainText("you said A wins · waiting for the model");
    await expect(pane(page, 2).getByRole("button", { name: /^predict (A|B) wins/ })).toHaveCount(0); // one per market
    await expect(page.locator("header")).toContainText(ME);
    await shot(page, "predict-called-1280");
  });

  test("a market the arena closed shows the split as text, takes no click, and the command says why", async ({ page }) => {
    await stub(page, () => [
      market(null, [5, 2, 0], { open: false }),
      market(0, [1, 1], { open: false }),
      market(1, [3, 2], { open: false, open_until_reveal: true }),
    ]);
    await fixtureWallet(page, false);
    await page.goto("/terminal");
    await expect(pane(page, 2)).toContainText("who wins? no stake  A 71%  B 29% · closed");
    await expect(pane(page, 2)).toContainText("71% say A wins");
    await expect(page.getByRole("button", { name: /^predict/ })).toHaveCount(0);
    await expect(pane(page, 2)).not.toContainText("a click connects a NEAR wallet");
    await expect(pane(page, 2)).not.toContainText("can steer this"); // a closed market's label no longer matters
    await page.locator("#cmdline").fill("predict 480 1 fooled");
    await page.locator("#cmdline").press("Enter");
    await expect(page.locator(".status")).toContainText("predictions on attack 1 in duel #480 are closed");
    await expect(page.locator(".hot-connector-popup")).toHaveCount(0); // no wallet for a call that cannot land
    await shot(page, "predict-closed-1280");
  });

  test("settled: right and wrong in words, a settle for the unscored duel, one claim for every scored deposit", async ({
    page,
  }) => {
    await stub(
      page,
      () => [market(null, [5, 2, 0], { open: false }), market(0, [1, 1], { open: false }), market(1, [3, 2], { steered_by: "nearbuddy-solver.testnet" })],
      () => [
        { duel_id: "478", index: 0, pick: "Held", at: "1", verdict: null },
        { duel_id: "479", index: null, pick: "A", at: "2", verdict: "Right" },
        { duel_id: "479", index: 0, pick: "Flipped", at: "3", verdict: "Wrong" },
        { duel_id: "480", index: 1, pick: "Held", at: "4", verdict: null },
      ],
    );
    await fixtureWallet(page, true);
    await page.goto("/terminal");
    await expect(page.locator("header")).toContainText(ME);
    const mine = pane(page, 2);
    await expect(mine).toContainText("your predictions");
    await expect.poll(words(page, 2)).toContain("#479 who wins: you were right: you said A wins");
    await expect.poll(words(page, 2)).toContain("#479 attack 0: you were wrong: you said it will be fooled");
    await expect(mine.locator(".win", { hasText: "you were right" })).toHaveCount(1);
    await expect(mine.locator(".loss", { hasText: "you were wrong" })).toHaveCount(1);
    // the open market on the live duel is still taking predictions: settling it would score nothing
    await expect(mine.getByRole("button", { name: /^score the predictions on duel/ })).toHaveText(["[settle #478]"]);
    // steered by a keyed agent's owner: named next to the buttons
    await expect
      .poll(words(page, 2))
      .toContain("the agent's owner nearbuddy-solver.testnet picks which reply it signs, so it can steer this");
    await expect(mine).toContainText("predict fooled 60% ▸holds 40%"); // the viewer's own call on attack 1
    await shot(page, "predict-settled-1280");
    await mine.getByRole("button", { name: "claim the deposits of your 2 scored predictions" }).click();
    await expect(page.locator("#cmdline")).toHaveValue("claim predictions");
    await expect(page.locator(".status")).toContainText(
      "claimed 2 prediction deposits back: 0.00679 NEAR returned, 0.00141 NEAR kept once for your board row · tx FixtureTx1",
    );
    await mine.getByRole("button", { name: "score the predictions on duel 478" }).click();
    await expect(page.locator(".status")).toContainText("settled the predictions on duel #478");
    const sent = await page.evaluate(() => window.__sent.map((s) => [s.receiverId, (s.actions[0] as { params: unknown }).params]));
    expect(sent).toEqual([
      [PREDICT, { methodName: "claim", args: {}, gas: "30000000000000", deposit: "0" }],
      [PREDICT, { methodName: "settle", args: { duel_id: "478" }, gas: "200000000000000", deposit: "0" }],
    ]);
  });
});

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true });

  test("the no-stake prediction is in the first screen, every line fits, no sideways scroll", async ({ page }) => {
    await stub(page, () => OPEN);
    await fixtureWallet(page, false);
    await page.goto("/terminal");
    const first = pane(page, 2).getByRole("button", { name: /^predict A wins, no stake/ });
    await expect(first).toBeVisible();
    expect((await first.boundingBox())!.y + 20).toBeLessThan(844);
    await expect.poll(words(page, 2)).toContain("closes at the reveal: whoever runs the agent knows the answer first");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await exactWidths(page);
    await shot(page, "predict-open-390");
  });
});
