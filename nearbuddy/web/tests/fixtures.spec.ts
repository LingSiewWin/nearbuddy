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
  ...(nonce === "41" ? { side: "Long" } : {}), // 39 and 40 come from a solver that only sold (no side)
  amount_in,
  quote_out,
  oracle_mid: String(mid),
  quoted_at: now - Number(ago),
  bps_vs_oracle: bps,
}));
// the oracle era reverses the lifetime order: B leads from duel 257 on, A's lead came from the operator era
const tallyOf = (alpha_bps: number, wins: number, ties: number, losses: number) => ({
  alpha_bps,
  wins,
  ties,
  losses,
  duels: wins + ties + losses,
});
const eras = {
  from: 257,
  operator_duels: 257,
  oracle_duels: 155,
  by_agent: {
    [PK_A]: { oracle: tallyOf(-20, 3, 1, 5), operator_alpha_bps: 160 },
    [PK_B]: { oracle: tallyOf(35, 5, 1, 3), operator_alpha_bps: -95 },
  },
};
const commitOn = { commit_reveal: true, no_reveal_bps: 500, require_consent: true };
const arena = (deploy13: boolean) => ({
  at: now,
  rpc: "https://fixture.rpc",
  contract: "arena.nearbuddy-solver.testnet",
  config: { next_duel: "412", slash_bps: 1000, min_chaos_deposit: "10000000000000000000000", ...(deploy13 ? {} : commitOn) },
  leaderboard: [agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140), agent(PK_B, "Qwen/Qwen3-30B-A3B", -60)],
  duels: [duel],
  stats: { scanned: 40, verified_decisions: 71, attacks: 9 },
  ...(deploy13 ? {} : { eras }),
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

const OPEN_TX = "Cns1Xk9pQz7LmV4rT2wYb8NdF6sGa3eU1oKiH5jRcP9M";
// GET /api/events body; `oldest_ms` far back so the duel sits inside the scanned window
const events = (opened: unknown, events: unknown[] = []) => ({
  at: now,
  window: 200,
  oldest_ms: now - 3 * 3_600_000,
  opened,
  events,
});
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const chainEv = (event: string, method: string, pk: string, at_ms: number) => ({
  event,
  duel_id: "411",
  agent_pk: pk,
  method,
  tx: `${method}Tx${at_ms}`,
  at_ms,
});
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

test("arena: commit-reveal word and the execution box from solver quality", async ({ page }) => {
  await stub(page, "arena", arena(false));
  await page.goto("/arena");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal on · pairing: consent required");
  const exec = page.locator(box("execution"));
  await expect(exec).toBeVisible();
  const body = page.locator("body");
  await expect(body).toContainText("every follower in a tick gets one price (batched RFQ)");
  await expect(body).toContainText("quotes alice.testnet: 0.250 wNEAR←0.6409 USDC"); // Long; share, not the 2.1782 batch
  await expect(body).toContainText("quotes carol.testnet: 0.500 wNEAR←1.2818 USDC"); // older solver fallback
  await expect(body).toContainText("buy     0.500 wNEAR ←     1.2818 USDC"); // nonce 41 fills carry side Long
  await expect(body).toContainText("sell    0.250 wNEAR →     0.6395 USDC"); // nonce 40: no side, read as Short
  await expect(page.locator('span[title="Long: bought wNEAR, paid USDC"]')).toHaveCount(3);
  await expect(page.locator("span.win", { hasText: "+1.4 bps" })).toHaveCount(3);
  await expect(page.locator("span.loss", { hasText: "-0.8 bps" })).toHaveCount(2);
  await expect(page.locator('span.dim[title="not priced against the oracle mid"]')).toHaveCount(1); // null bps row
  await shot(page, "arena-top");
  await shot(page, "arena-box5", "execution", 13);
});

test("arena: deploy 13 data still renders standings, commit-reveal off, solver offline", async ({ page }) => {
  await stub(page, "arena", arena(true));
  await page.goto("/arena");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal off");
  await expect(page.locator("pre.wrap").first()).not.toContainText("pairing:");
  await expect(page.locator("pre a[href^='/agent/']").first()).toBeVisible();
  await expect(page.locator("span.ok", { hasText: "enclave" }).first()).toBeVisible(); // verified column
  await expect(page.locator("body")).toContainText("solver offline: no execution data");
});

test("duel: commit-reveal row and the no-reveal forfeit marker", async ({ page }) => {
  await stub(page, "events", events({ duel_id: "411", method: "open_duel_consented", tx: OPEN_TX, at_ms: now - 360_000 }));
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
  await page.goto("/duel/411");
  const body = page.locator("body");
  await expect(body).toContainText("calls hidden until reveal · no reveal = forfeit + 5 % of bond to the opponent");
  await expect(page.locator("span.ok", { hasText: "revealed" })).toBeVisible();
  await expect(page.locator("span.loss", { hasText: "no reveal: forfeit" })).toBeVisible();
  await expect(page.locator("span.ok", { hasText: "both agents signed this duel" })).toBeVisible();
  await expect(page.locator(`a[href$="/txns/${OPEN_TX}"]`)).toBeVisible();
  await expect(body).toContainText("no reveal = forfeit + no_reveal_bps of bond to the opponent (both: tie, to the protocol)");
  await shot(page, "duel");
});

test("duel: deploy 13 data (no commit fields, no get_no_reveal) renders the sides box", async ({ page }) => {
  await page.route("**/api/events**", (r) => r.fulfill({ status: 502, json: { error: "fastnear down" } }));
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
  await page.goto("/duel/411");
  await expect(page.locator(box("sides"))).toBeVisible();
  await expect(page.locator("body")).toContainText("this contract predates commit-reveal");
  await expect(page.locator("body")).not.toContainText("no reveal:");
  await expect(page.locator("body")).toContainText("no proof");
  await expect(page.locator("body")).toContainText("this contract predates consented pairing");
});

test("duel: commit and reveal times per side from the contract's events", async ({ page }) => {
  const [cA, rA, cB] = [now - 300_000, now - 240_000, now - 290_000];
  await stub(
    page,
    "events",
    events({ duel_id: "411", method: "open_duel_consented", tx: OPEN_TX, at_ms: now - 360_000 }, [
      chainEv("commit", "commit_intent", PK_A, cA),
      chainEv("commit", "commit_intent", PK_B, cB),
      chainEv("intent", "reveal_intent", PK_A, rA),
    ]),
  );
  const live = { ...duel, resolved: false, close_at: NS(now + 120_000), outcome: null, last_intent_b: null };
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412", ...commitOn },
    no_reveal: [false, false],
    duel: live,
    a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
  });
  await page.goto("/duel/411");
  const body = page.locator("body");
  await expect(body).toContainText(`A commit         committed ${hms(cA)} · revealed ${hms(rA)}`);
  await expect(body).toContainText(`B commit         committed ${hms(cB)} · hidden`);
  await expect(page.locator(`a[href$="/txns/reveal_intentTx${rA}"]`)).toHaveClass(/ok/);
  await expect(body).not.toContainText("earlier events not shown");
  await shot(page, "duel-commits");
});

test("duel: a record without open_at still renders, with no window note", async ({ page }) => {
  await stub(page, "events", events(null));
  const { open_at: _, ...noOpen } = duel;
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412", ...commitOn },
    no_reveal: [false, false],
    duel: noOpen,
    a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
  });
  await page.goto("/duel/411");
  await expect(page.locator(box("sides"))).toBeVisible();
  await expect(page.locator("pre.wrap").first()).toContainText("· - →");
  await expect(page.locator("body")).toContainText("A commit         no commit seen");
  await expect(page.locator("body")).not.toContainText("earlier events not shown");
});

test("duel: open tx outside the scanned window falls back to today's require_consent, labelled", async ({ page }) => {
  await stub(page, "events", events(null));
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412", ...commitOn },
    no_reveal: [false, false],
    duel,
    a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
  });
  await page.goto("/duel/411");
  await expect(page.locator("span.ok", { hasText: "consent required" })).toBeVisible();
  await expect(page.locator("body")).toContainText("from get_config now; the open tx is not in the scanned window");
  await expect(page.locator("body")).not.toContainText("both agents signed");
  await expect(page.locator("body")).toContainText("A commit         no commit seen");
});

test("agent: execution summary for this agent's followers", async ({ page }) => {
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
  await page.goto(`/agent/${encodeURIComponent(PK_A)}`);
  const body = page.locator("body");
  await expect(body).toContainText("alice.testnet  3 fills  avg +0.3 bps vs oracle mid  best +1.4  worst -0.8"); // null row counted, not averaged
  await expect(body).toContainText("bob.testnet  2 fills  avg +0.3 bps vs oracle mid  best +1.4  worst -0.8");
  await expect(body).not.toContainText("carol.testnet");
  await shot(page, "agent");
});

test("arena: standings rank by alpha from duel 257 on, lifetime one click away", async ({ page }) => {
  await stub(page, "arena", arena(false));
  await page.goto("/arena");
  const body = page.locator("body");
  await expect(body).toContainText("ranked by alpha from duel 257 on, then shield");
  await expect(body).toContainText("alpha from duel 257 on (TEE oracle), 257 operator-scored duels excluded · show lifetime");
  const rows = page.locator("pre a[href^='/agent/']");
  await expect(rows.first()).toHaveAttribute("href", `/agent/${encodeURIComponent(PK_B)}`); // +35 beats -20
  await expect(page.locator("span.win", { hasText: "+35 bps" })).toHaveAttribute(
    "title",
    "duels 257+ +35 bps · operator era -95 bps · lifetime -60 bps",
  );
  await page.getByRole("button", { name: "show lifetime" }).click();
  await expect(body).toContainText("ranked by lifetime alpha, then shield");
  await expect(body).toContainText("lifetime alpha, incl. 257 operator-scored duels (#0-256)");
  await expect(rows.first()).toHaveAttribute("href", `/agent/${encodeURIComponent(PK_A)}`); // +140 lifetime
  await expect(page.locator("span.win", { hasText: "+140 bps" })).toBeVisible();
  await shot(page, "arena-eras");
});

test("arena: an incomplete era split ranks by lifetime and says so in the note row", async ({ page }) => {
  await stub(page, "arena", { ...arena(false), eras: { ...eras, complete: false, unread: 3 } });
  await page.goto("/arena");
  const body = page.locator("body");
  await expect(body).toContainText("ranked by lifetime alpha, then shield");
  await expect(body).toContainText("era split incomplete (3 oracle-era duels unread, retrying): lifetime alpha");
  await expect(page.locator("pre a[href^='/agent/']").first()).toHaveAttribute(
    "href",
    `/agent/${encodeURIComponent(PK_A)}`,
  ); // +140 lifetime leads; the split (B first) is held back
  await expect(page.getByRole("button", { name: "show lifetime" })).toHaveCount(0);
});

test("arena: a mainnet arena (oracle era from duel 0) shows no operator era", async ({ page }) => {
  await stub(page, "arena", { ...arena(false), eras: { ...eras, from: 0, operator_duels: 0 } });
  await page.goto("/arena");
  await expect(page.locator("body")).toContainText("every duel on this arena was scored by the TEE oracle");
  await expect(page.locator("body")).toContainText("ranked by lifetime alpha, then shield");
  await expect(page.getByRole("button", { name: "show lifetime" })).toHaveCount(0);
});

test("agent: record from duel 257 on, operator era behind a toggle", async ({ page }) => {
  const row = (id: string, result: string, pnl: number) => ({
    id,
    opponent: PK_B,
    symbol: "wrap.near",
    open_at: NS(now - 600_000),
    close_at: NS(now - 300_000),
    resolved: true,
    result,
    pnl,
    side: "Long",
    size_bps: 5000,
    proof_hash: PROOF,
    open_price: "256100000",
    close_price: "257400000",
    slashed: "0",
    attacks: 0,
    attacks_on_me: null,
  });
  const base = {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    indexed: true,
    next_duel: 412,
    slash_bps: 1000,
    min_chaos_deposit: "10000000000000000000000",
    agent: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
    followers: [],
    execution: null,
    eras: { from: 257, oracle: tallyOf(-20, 1, 0, 1), operator: { alpha_bps: 160, duels: 257, mine: null } },
  };
  await page.route("**/api/agent**", (r) =>
    r.fulfill({
      json: r.request().url().includes("era=operator")
        ? {
            ...base,
            eras: { ...base.eras, operator: { alpha_bps: 160, duels: 257, mine: 2 } },
            era: "operator",
            scanned: 257,
            duels: [row("201", "win", 90), row("200", "win", 70)],
          }
        : { ...base, era: "oracle", scanned: 155, duels: [row("300", "loss", -45), row("299", "win", 25)] },
      headers: { "cache-control": "no-store" },
    }),
  );
  await page.goto(`/agent/${encodeURIComponent(PK_A)}`);
  const body = page.locator("body");
  await expect(body).toContainText(
    "alpha from duel 257 on (TEE oracle) -20 bps · operator era (#0-256, 257 duels) excluded: +160 bps of the lifetime alpha · lifetime +140 bps",
  );
  await expect(body).toContainText("oracle-scored, duels 257+ · 2 duels");
  await expect(body).toContainText("1 win  0 tie  1 loss   net -20 bps");
  await expect(page.getByRole("link", { name: "#300" })).toBeVisible();
  await page.getByRole("button", { name: "show operator era (#0-256, excluded above)" }).click();
  await expect(body).toContainText("operator era (#0-256, 257 duels, 2 of them this agent's) excluded: +160 bps of the lifetime alpha");
  await expect(body).toContainText("operator-scored, duels 0-256 · 2 duels");
  await expect(body).toContainText("2 win  0 tie  0 loss   net +160 bps");
  await expect(page.getByRole("link", { name: "#201" })).toBeVisible();
  await expect(page.getByRole("link", { name: "#300" })).toHaveCount(0);
  await page.getByRole("button", { name: "back to the oracle era" }).click();
  await expect(page.getByRole("link", { name: "#300" })).toBeVisible();
  await shot(page, "agent-eras");
});

test("agent: a voided duel is counted as void, not a tie; the pre-API frame uses the build's network", async ({
  page,
}) => {
  const row = (id: string, result: string, pnl: number, prices: [string, string]) => ({
    id,
    opponent: PK_B,
    symbol: "wrap.near",
    open_at: NS(now - 600_000),
    close_at: NS(now - 300_000),
    resolved: true,
    result,
    pnl,
    side: "Long",
    size_bps: 5000,
    proof_hash: PROOF,
    open_price: prices[0],
    close_price: prices[1],
    slashed: "0",
    attacks: 0,
    attacks_on_me: null,
  });
  let release = () => {};
  const answered = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/agent**", async (r) => {
    await answered; // hold the API so the first frame is visible
    await r.fulfill({
      json: {
        at: now,
        rpc: "https://fixture.rpc",
        contract: "arena.nearbuddy-solver.testnet",
        next_duel: 412,
        slash_bps: 1000,
        min_chaos_deposit: "10000000000000000000000",
        agent: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
        followers: [],
        execution: null,
        era: "oracle",
        scanned: 155,
        eras: {
          from: 257,
          complete: true,
          unread: 0,
          oracle: { ...tallyOf(-20, 1, 0, 1), voids: 1 },
          operator: { alpha_bps: 160, duels: 257, mine: null },
        },
        duels: [
          row("301", "void", 0, ["0", "0"]),
          row("300", "loss", -45, ["256100000", "255000000"]),
          row("299", "win", 25, ["256100000", "257400000"]),
        ],
      },
      headers: { "cache-control": "no-store" },
    });
  });
  await page.goto(`/agent/${encodeURIComponent(PK_A)}`);
  const body = page.locator("body");
  // this Playwright build has no NEXT_PUBLIC_NEAR_NETWORK: testnet, so 257 (a mainnet build reads 0, unit-tested)
  await expect(body).toContainText("oracle-scored, duels 257+ · 0 duels");
  release();
  await expect(body).toContainText("1 win  0 tie  1 loss  1 void   net -20 bps");
  await expect(page.locator('span[title="duel #301 void"]')).toHaveText("·");
  await expect(page.locator('span[title="duel #301 void"]')).toHaveClass("dim");
});

// testnet duels #0-21: resolved, but closed without an outcome (pre-migration layout)
const legacyDuel = { ...duel, id: "7", symbol: "BTC/USD", resolved: true, outcome: null, open_price: null };

test("agent: a resolved duel without an outcome is labelled, not open, and stays out of W/T/L", async ({ page }) => {
  const row = (id: string, result: string, pnl: number | null) => ({
    id,
    opponent: PK_B,
    symbol: "BTC/USD",
    open_at: NS(now - 600_000),
    close_at: NS(now - 300_000),
    resolved: true,
    result,
    pnl,
    side: "Long",
    size_bps: 5000,
    proof_hash: ZERO,
    open_price: null,
    close_price: null,
    slashed: "0",
    attacks: 0,
    attacks_on_me: null,
  });
  const body = (era: string) => ({
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    next_duel: 412,
    slash_bps: 1000,
    min_chaos_deposit: "10000000000000000000000",
    agent: agent(PK_A, "stub/deterministic", -10),
    followers: [],
    execution: null,
    era,
    scanned: era === "operator" ? 257 : 155,
    eras: {
      from: 257,
      complete: true,
      unread: 0,
      oracle: tallyOf(0, 0, 0, 0),
      operator: { alpha_bps: -10, duels: 257, mine: era === "operator" ? 2 : null },
    },
    duels: era === "operator" ? [row("22", "tie", 0), row("7", "no_outcome", null)] : [],
  });
  await page.route("**/api/agent**", (r) =>
    r.fulfill({
      json: body(r.request().url().includes("era=operator") ? "operator" : "oracle"),
      headers: { "cache-control": "no-store" },
    }),
  );
  await page.goto(`/agent/${encodeURIComponent(PK_A)}`);
  await page.getByRole("button", { name: /show operator era/ }).click();
  const page_ = page.locator("body");
  await expect(page_).toContainText("0 win  1 tie  0 loss   net +0 bps");
  await expect(page_).toContainText("1 resolved (no outcome recorded): pre-migration duels, not scored");
  await expect(
    page.locator('span[title="resolved (no outcome recorded): a pre-migration duel, never scored"]'),
  ).toHaveText("n/a   ");
  await expect(page.locator('span[title="duel #7 resolved (no outcome recorded)"]')).toHaveText("?");
  await expect(page.locator("span.open", { hasText: /^open\s+$/ })).toHaveCount(0); // no row reads "open"
});

test("arena: a second duel pair gets one row per pair in the duels box; a single pair gets none", async ({ page }) => {
  const PK_G = "Z2xtLTUuMy1mbGFzaC1hZ2VudC1rZXktZml4dHVyZTA=";
  const PK_W = "cXdlbjMuNi0zNWItYWdlbnQta2V5LWZpeHR1cmUwMDA=";
  const two = arena(false);
  const PK_R = "cmVkdGVhbS1zdHViLWFnZW50LWtleS1maXh0dXJlMDA=";
  const PK_S = "cmVkdGVhbS1zdHViLWFnZW50LWtleS1maXh0dXJlMDE=";
  two.leaderboard.push(
    agent(PK_G, "z-ai/glm-5.3-flash", 37),
    agent(PK_W, "Qwen/Qwen3.6-35B-A3B-FP8", 37),
    agent(PK_R, "redteam/stub", 0),
    agent(PK_S, "redteam/stub", 0),
  );
  Object.assign(two.stats, {
    pairs: [
      { a: PK_R, b: PK_S, first: 355, last: 359, n: 2 }, // the red-team stub pair: no row, it is not an arena pair
      { a: PK_G, b: PK_W, first: 350, last: 358, n: 9 },
      { a: PK_A, b: PK_B, first: 319, last: 357, n: 31 },
      { a: PK_A, b: PK_G, first: 356, last: 356, n: 1 }, // a one-off probe: no row
    ],
  });
  await stub(page, "arena", two);
  await page.goto("/arena");
  const body = page.locator("body");
  await expect(body).toContainText("pair 1           DeepSeek-V3.1 vs Qwen3-30B-A3B  #319-#357 · 31 of last 40");
  await expect(body).toContainText("pair 2           glm-5.3-flash vs Qwen3.6-35B-A3B-FP8  #350-#358 · 9 of last 40");
  await expect(body).not.toContainText("pair 3");
  await expect(page.locator(`a[title="${PK_G}"]`, { hasText: "glm-5.3-flash" })).toHaveAttribute(
    "href",
    `/agent/${encodeURIComponent(PK_G)}`,
  );
  // one stub rule for standings and pairs: "redteam/stub" agents are hidden too, and "show all" brings both back
  await expect(body).toContainText("2 stub agents hidden (no model, no proof) · show all");
  await page.getByRole("button", { name: /show all/ }).click();
  await expect(body).toContainText("pair 3           stub vs stub  #355-#359 · 2 of last 40");
  const one = arena(false);
  Object.assign(one.stats, { pairs: [{ a: PK_A, b: PK_B, first: 319, last: 357, n: 40 }] });
  await stub(page, "arena", one);
  await page.reload();
  await expect(page.locator(box("duels"))).toBeVisible();
  await expect(body).not.toContainText("pair 1");
});

test("duel: a resolved duel without an outcome says so instead of pending", async ({ page }) => {
  await stub(page, "events", events(null));
  await stub(page, "duel", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    oracle: "price-oracle.testnet",
    config: { next_duel: "412" },
    no_reveal: null,
    duel: legacyDuel,
    a: agent(PK_A, "stub/deterministic", -10),
    b: agent(PK_B, "stub/deterministic", -1),
  });
  await page.goto("/duel/7");
  const body = page.locator("body");
  await expect(page.locator("pre.wrap").first()).toContainText("resolved (no outcome recorded)");
  await expect(body).toContainText("resolved (no outcome recorded): a pre-migration duel, never scored");
  await expect(body).toContainText("none recorded");
  await expect(body).not.toContainText("pending: anyone can resolve");
  await expect(body).not.toContainText("undecided");
});
