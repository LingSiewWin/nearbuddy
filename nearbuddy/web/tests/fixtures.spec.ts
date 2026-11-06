// The pages against fixture data: /api/* is stubbed in the browser, so no RPC or solver is needed. Covers
// the commit-reveal markers and the execution box, and that deploy-13 data (no commit-reveal fields, no
// solver quality) still renders. SHOT=1 saves screenshots to docs/web-exec-*.png.
import { expect, type Page, test } from "@playwright/test";

const box = (name: string) => `pre span.hi:text-is("${name}")`;
const PK_A = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const PK_B = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";
const PROOF = "3q2+7wAAAAD+7wAAAAD+7wAAAAD+7wAAAAD+7wAAAAA=";
const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NS = (ms: number) => String(BigInt(ms) * 1_000_000n);
const now = Date.now();

const agent = (pk: string, model: string, alpha: number) => ({
  owner: "nearbuddy-solver.testnet",
  pk,
  model_id: model,
  bond: "500000000000000000000000",
  alpha_bps: alpha,
  shield: 3,
  in_duel: null,
  tee: true,
});
const mandate = {
  allowance: "5000000000000000000000000",
  spent: "750000000000000000000000",
  per_tx_cap: "250000000000000000000000",
  allowed_tokens: ["wrap.near"],
  expires_at: NS(now + 30 * 86_400_000),
  revoked: false,
};
const intent = (pk: string, side: "Long" | "Short", proof: string) => ({
  agent_pk: pk,
  duel_id: "411",
  side,
  size_bps: 5000,
  nonce: "41",
  expires_at: NS(now),
  proof_hash: proof,
});
const duel = {
  id: "411",
  a: PK_A,
  b: PK_B,
  symbol: "wrap.near",
  open_at: NS(now - 360_000),
  close_at: NS(now - 60_000),
  pool: "100000000000000000000000",
  injections: [],
  resolved: true,
  last_intent_a: intent(PK_A, "Long", PROOF),
  last_intent_b: null,
  outcome: {
    open_price: "256100000",
    close_price: "257400000",
    pnl_a: 25,
    pnl_b: 0,
    winner: PK_A,
    slashed: "50000000000000000000000",
    injections: 1,
  },
};
// two ticks: every follower in a tick gets the same price (batched RFQ)
const quality = [
  ["alice.testnet", "39", "250000000000000000000000", "640000", 256_000_000, null, 900_000], // old row, unpriced
  ["alice.testnet", "40", "250000000000000000000000", "639500", 255_900_000, -0.8, 610_000],
  ["bob.testnet", "40", "100000000000000000000000", "255800", 255_900_000, -0.8, 610_000],
  ["alice.testnet", "41", "250000000000000000000000", "640900", 256_100_000, 1.4, 42_000],
  ["bob.testnet", "41", "100000000000000000000000", "256360", 256_100_000, 1.4, 42_000],
  ["carol.testnet", "41", "500000000000000000000000", "1281800", 256_100_000, 1.4, 42_000],
].map(([follower, nonce, amount_in, quote_out, mid, bps, ago]) => ({
  follower,
  intent_nonce: nonce,
  amount_in,
  quote_out,
  oracle_mid: String(mid),
  quoted_at: now - Number(ago),
  bps_vs_oracle: bps,
}));
const commitOn = { commit_reveal: true, no_reveal_bps: 500, require_consent: true };
const arena = (deploy13: boolean) => ({
  at: now,
  rpc: "https://fixture.rpc",
  contract: "arena.nearbuddy-solver.testnet",
  config: { next_duel: "412", slash_bps: 1000, min_chaos_deposit: "10000000000000000000000", ...(deploy13 ? {} : commitOn) },
  leaderboard: [agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140), agent(PK_B, "Qwen/Qwen3-30B-A3B", -60)],
  duels: [duel],
  stats: { scanned: 40, verified_decisions: 71, attacks: 9 },
  followers: { [PK_A]: [["alice.testnet", mandate], ["bob.testnet", mandate]] },
  solver: deploy13 ? null : { intents: solverIntents, pending: {}, fills: [], quality },
});
// the intent row is cut at the box edge, so one quote per intent: a batched-RFQ quote (batch total in
// `quote`, this follower's share in `quote_out`) and one from an older solver (no `quote_out`)
const solverIntents = [
  {
    ...intent(PK_A, "Long", PROOF),
    tx: "8xQmvW2hJp3kTfR9ZbYc5LnD4sGa7eU1oKiV6yXwN2Mt",
    quotes: [
      {
        follower: "alice.testnet",
        amount: "250000000000000000000000",
        quote_out: "640900",
        price: "2.5636",
        quote: { quote: { amountOutFormatted: "2.1782" } },
      },
    ],
  },
  {
    ...intent(PK_A, "Long", PROOF),
    nonce: "39",
    tx: "5bTnR1kYqWv8cHs3LmP9dJx2Fz7Ue4Ga6oKiN1yXwQ2M",
    quotes: [
      { follower: "carol.testnet", amount: "500000000000000000000000", quote: { quote: { amountOutFormatted: "1.2818" } } },
    ],
  },
];

const stub = (page: Page, path: string, body: unknown) =>
  page.route(`**/api/${path}**`, (r) => r.fulfill({ json: body, headers: { "cache-control": "no-store" } }));
const shot = async (page: Page, name: string, from?: string, lines = 0) => {
  if (!process.env.SHOT) return;
  const path = `../docs/web-exec-${name}.png`;
  if (!from) return void (await page.screenshot({ path }));
  const t = (await page.locator(box(from)).boundingBox())!;
  const w = page.viewportSize()!.width;
  await page.screenshot({ path, fullPage: true, clip: { x: 0, y: t.y - 8, width: w, height: t.height * lines + 16 } });
};

test("terminal: commit-reveal word and the execution box from solver quality", async ({ page }) => {
  await stub(page, "arena", arena(false));
  await page.goto("/terminal");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal on");
  const exec = page.locator(box("execution"));
  await expect(exec).toBeVisible();
  const body = page.locator("body");
  await expect(body).toContainText("every follower in a tick gets one price (batched RFQ)");
  await expect(body).toContainText("quotes alice.testnet: 0.250 wNEAR→0.6409 USDC"); // share, not the 2.1782 batch
  await expect(body).toContainText("quotes carol.testnet: 0.500 wNEAR→1.2818 USDC"); // older solver fallback
  await expect(body).toContainText("0.500 wNEAR →     1.2818 USDC");
  await expect(page.locator("span.win", { hasText: "+1.4 bps" })).toHaveCount(3);
  await expect(page.locator("span.loss", { hasText: "-0.8 bps" })).toHaveCount(2);
  await expect(page.locator('span.dim[title="not priced against the oracle mid"]')).toHaveCount(1); // null bps row
  await shot(page, "arena-top");
  await shot(page, "arena-box5", "execution", 13);
});

test("terminal: deploy 13 data still renders standings, commit-reveal off, solver offline", async ({ page }) => {
  await stub(page, "arena", arena(true));
  await page.goto("/terminal");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal off");
  await expect(page.locator("pre a[href^='/agent/']").first()).toBeVisible();
  await expect(page.locator("span.ok", { hasText: "enclave" }).first()).toBeVisible(); // verified column
  await expect(page.locator("body")).toContainText("solver offline: no execution data");
});

test("terminal duel: commit-reveal row and the no-reveal slashed marker", async ({ page }) => {
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412", ...commitOn },
    no_reveal: [false, true],
    duel,
    a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
  });
  await page.goto("/terminal/duel/411");
  const body = page.locator("body");
  await expect(body).toContainText("calls hidden until reveal · no reveal costs 5 % of bond");
  await expect(page.locator("span.ok", { hasText: "revealed" })).toBeVisible();
  await expect(page.locator("span.loss", { hasText: "no-reveal slashed" })).toBeVisible();
  await shot(page, "duel");
});

test("terminal duel: deploy 13 data (no commit fields, no get_no_reveal) renders the sides box", async ({ page }) => {
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412" },
    no_reveal: null,
    duel: { ...duel, last_intent_b: intent(PK_B, "Short", ZERO) },
    a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
  });
  await page.goto("/terminal/duel/411");
  await expect(page.locator(box("sides"))).toBeVisible();
  await expect(page.locator("body")).toContainText("this contract predates commit-reveal");
  await expect(page.locator("body")).not.toContainText("no-reveal slashed");
  await expect(page.locator("body")).toContainText("no proof");
});

test("terminal agent: execution summary for this agent's followers", async ({ page }) => {
  await stub(page, "agent", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    scanned: 1,
    indexed: true,
    next_duel: 412,
    slash_bps: 1000,
    min_chaos_deposit: "10000000000000000000000",
    agent: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    followers: [
      ["alice.testnet", mandate],
      ["bob.testnet", mandate],
    ],
    duels: [],
    execution: quality.filter((q) => q.follower !== "carol.testnet"),
  });
  await page.goto(`/terminal/agent/${encodeURIComponent(PK_A)}`);
  const body = page.locator("body");
  await expect(body).toContainText("alice.testnet  3 fills  avg +0.3 bps vs oracle mid  best +1.4  worst -0.8"); // null row counted, not averaged
  await expect(body).toContainText("bob.testnet  2 fills  avg +0.3 bps vs oracle mid  best +1.4  worst -0.8");
  await expect(body).not.toContainText("carol.testnet");
  await shot(page, "agent");
});
