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
// every fixture duel page asks /api/verify once its duel is resolved: answer here, never from the network
test.beforeEach(async ({ page }) => {
  await stub(page, "verify", { duel_id: "411", status: "checked", command: "bun run verify-duel 411", counts: { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 }, lines: [] });
});
const shot = async (page: Page, name: string, from?: string, lines = 0) => {
  if (!process.env.SHOT) return;
  const path = `../docs/web-exec-${name}.png`;
  if (!from) return void (await page.screenshot({ path }));
  const t = (await page.locator(box(from)).boundingBox())!;
  const w = page.viewportSize()!.width;
  await page.screenshot({ path, fullPage: true, clip: { x: 0, y: t.y - 8, width: w, height: t.height * lines + 16 } });
};

test("arena: commit-reveal word; standings and duels only, no follower, solver or execution boxes", async ({
  page,
}) => {
  await stub(page, "arena", arena(false));
  await page.goto("/arena");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal on · pairing: consent required");
  await expect(page.locator(box("standings"))).toBeVisible();
  await expect(page.locator(box("duels"))).toBeVisible();
  for (const name of ["followers", "solver", "execution"]) await expect(page.locator(box(name))).toHaveCount(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("clearinghouse");
  await expect(body).not.toContainText("tamper test");
  await shot(page, "arena-top");
});

test("arena: deploy 13 data still renders standings, commit-reveal off, solver offline", async ({ page }) => {
  await stub(page, "arena", arena(true));
  await page.goto("/arena");
  await expect(page.locator("pre.wrap").first()).toContainText("commit-reveal off");
  await expect(page.locator("pre.wrap").first()).not.toContainText("pairing:");
  await expect(page.locator("pre a[href^='/agent/']").first()).toBeVisible();
  await expect(page.locator("span.ok", { hasText: "enclave" }).first()).toBeVisible(); // verified column
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

// The spectator's kinds ("fake_news/against/-57.7", 22-26 chars) in the attack rows of a running duel: the kind
// column stays fixed, the full kind is on hover, and every line of the box keeps the page width W = 112.
const attacked = {
  ...duel,
  resolved: false,
  close_at: NS(now + 120_000),
  outcome: null,
  last_intent_b: null,
  injections: [
    { kind: "fake_news/against/-57.7", payload_hash: PROOF, target: PK_B, block: "245678901" },
    { kind: "fake_news/flat/no_open", payload_hash: ZERO, target: PK_A, block: "245678911" },
    { kind: "fake_news", payload_hash: ZERO, target: PK_B, block: "245678921" },
  ],
};
const attackLines = async (page: Page) =>
  (await page.locator("pre").allTextContents())
    .join("\n")
    .split("\n")
    .filter((l) => l.includes("block 24567"));

for (const [name, path] of [
  ["arena", "/arena"],
  ["duel", "/duel/411"],
] as const)
  test(`${name}: spectator kinds fit the attack rows`, async ({ page }) => {
    await stub(page, "arena", { ...arena(false), duels: [attacked] });
    await stub(page, "events", events({ duel_id: "411", method: "open_duel_consented", tx: OPEN_TX, at_ms: now - 360_000 }));
    await stub(page, "duel", {
      at: now,
      rpc: "https://fixture.rpc",
      contract: "arena.nearbuddy-solver.testnet",
      oracle: "price-oracle.testnet",
      config: { next_duel: "412", ...commitOn },
      no_reveal: [false, false],
      duel: attacked,
      a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
      b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
    });
    await page.goto(path);
    await expect(page.locator('span[title="fake_news/against/-57.7"]')).toHaveText(/^against -57\.7\s*$/);
    await expect(page.locator('span[title="fake_news/flat/no_open"]')).toHaveText(/^flat no_open\s*$/);
    const lines = await attackLines(page);
    expect(lines).toHaveLength(3);
    ["245678901", "245678911", "245678921"].forEach((block, i) => {
      expect(lines[i]).toHaveLength(112); // nothing pushed past the right border
      expect(lines[i]).toContain(`block ${block}`); // the row's tail is still inside it
    });
    await shot(page, `kinds-${name}`);
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

test("arena: standings rank by alpha from duel 257 on, the operator era only in the hover", async ({ page }) => {
  await stub(page, "arena", arena(false));
  await page.goto("/arena");
  const body = page.locator("body");
  await expect(body).toContainText("ranked by alpha from duel 257 on, then shield");
  await expect(body).toContainText("alpha = pnl summed over duels 257+, scored by the TEE oracle · 1 bps = 0.01 %");
  const rows = page.locator("pre a[href^='/agent/']");
  await expect(rows.first()).toHaveAttribute("href", `/agent/${encodeURIComponent(PK_B)}`); // +35 beats -20
  await expect(page.locator("span.win", { hasText: "+35 bps" })).toHaveAttribute(
    "title",
    "duels 257+ +35 bps · operator era -95 bps · lifetime -60 bps",
  );
  await expect(page.getByRole("button", { name: "show lifetime" })).toHaveCount(0);
  await shot(page, "arena-eras");
});

test("arena: an incomplete era split ranks by lifetime and says so in the box title", async ({ page }) => {
  await stub(page, "arena", { ...arena(false), eras: { ...eras, complete: false, unread: 3 } });
  await page.goto("/arena");
  const body = page.locator("body");
  await expect(body).toContainText("ranked by lifetime alpha, then shield");
  await expect(body).toContainText("alpha = pnl summed over all scored duels (0-256: operator key, 257+: TEE oracle)");
  await expect(page.locator("pre a[href^='/agent/']").first()).toHaveAttribute(
    "href",
    `/agent/${encodeURIComponent(PK_A)}`,
  ); // +140 lifetime leads; the split (B first) is held back
  await expect(page.getByRole("button", { name: "show lifetime" })).toHaveCount(0);
});

test("arena: a mainnet arena (oracle era from duel 0) shows no operator era", async ({ page }) => {
  await stub(page, "arena", { ...arena(false), eras: { ...eras, from: 0, operator_duels: 0 } });
  await page.goto("/arena");
  await expect(page.locator("body")).not.toContainText("operator");
  await expect(page.locator("body")).toContainText("ranked by lifetime alpha, then shield");
  await expect(page.getByRole("button", { name: "show lifetime" })).toHaveCount(0);
});

test("agent: record from duel 257 on; no operator era, followers or execution", async ({ page }) => {
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
  await expect(body).toContainText("alpha from duel 257 on (TEE oracle) -20 bps");
  await expect(body).toContainText("oracle-scored, duels 257+ · 2 duels");
  await expect(body).toContainText("1 win  0 tie  1 loss   net -20 bps");
  await expect(page.getByRole("link", { name: "#300" })).toBeVisible();
  for (const gone of ["operator era", "show operator era", "followers", "execution"])
    await expect(body).not.toContainText(gone);
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
  await stub(page, "agent", {
    at: now,
    rpc: "https://fixture.rpc",
    contract: "arena.nearbuddy-solver.testnet",
    next_duel: 412,
    slash_bps: 1000,
    min_chaos_deposit: "10000000000000000000000",
    agent: agent(PK_A, "stub/deterministic", -10),
    era: "oracle",
    scanned: 155,
    eras: {
      from: 257,
      complete: true,
      unread: 0,
      oracle: tallyOf(0, 1, 0, 0),
      operator: { alpha_bps: -10, duels: 257, mine: null },
    },
    duels: [row("22", "tie", 0), row("7", "no_outcome", null)],
  });
  await page.goto(`/agent/${encodeURIComponent(PK_A)}`);
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
  // one fixture rule for standings and pairs: "redteam/..." agents never show, and there is no toggle to bring them back
  await expect(body).not.toContainText("redteam");
  await expect(page.getByRole("button", { name: /show all/ })).toHaveCount(0);
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

const duelBody = (d: unknown, noReveal: unknown = [false, false]) => ({
  at: now,
  rpc: "https://fixture.rpc",
  contract: "arena.nearbuddy-solver.testnet",
  oracle: "price-oracle.testnet",
  config: { next_duel: "412", ...commitOn },
  no_reveal: noReveal,
  duel: d,
  a: agent(PK_A, "deepseek-ai/DeepSeek-V3.1", 140),
  b: agent(PK_B, "Qwen/Qwen3-30B-A3B", -60),
});

test("duel: a resolved duel shows the verifier's counts, its lines on demand, and the CLI line", async ({ page }) => {
  await stub(page, "events", events(null));
  await stub(page, "verify", {
    duel_id: "411",
    status: "checked",
    command: "bun run verify-duel 411",
    counts: { PASS: 2, FAIL: 0, SKIP: 1, INFO: 1 },
    degraded: false,
    lines: [
      { result: "INFO", check: "duel", detail: "#411 wrap.near, resolved; scanned 40 txs" },
      { result: "PASS", check: "opened", detail: "open_duel returned duel id 411, tx HUcaDY7W" },
      { result: "PASS", check: "pnl A", detail: "+(close 2.5740 - open 2.5610) x 5000 / open = 25 bps, outcome 25" },
      { result: "SKIP", check: "intent A completion bytes", detail: "not checkable without the row" },
    ],
  });
  await stub(page, "duel", duelBody(duel));
  await page.goto("/duel/411");
  const body = page.locator("body");
  await expect(body).toContainText("4 verified       2 PASS · 0 FAIL · 1 SKIP · 1 INFO   show 4 lines");
  await expect(page.locator("span.loss", { hasText: "0 FAIL" })).toBeVisible();
  await expect(body).toContainText("reproduce        bun run verify-duel 411");
  await expect(body).not.toContainText("+(close 2.5740");
  await page.getByRole("button", { name: "show 4 lines" }).click();
  await expect(body).toContainText(
    "PASS  pnl A                      +(close 2.5740 - open 2.5610) x 5000 / open = 25 bps",
  );
  await expect(page.locator("span.warn", { hasText: /^SKIP$/ })).toBeVisible(); // the line's result cell
  await page.getByRole("button", { name: "hide lines" }).click();
  await expect(body).not.toContainText("+(close 2.5740");
  await shot(page, "duel-verified");
});

test("duel: deploy 17 records show their payout only once the duel is resolved", async ({ page }) => {
  const rec = (outcome: string, payout: string) => ({
    arm: "Cue",
    at: NS(now - 30_000),
    claimed: false,
    decided_by: null,
    headline: "Binance delists NEAR at midnight",
    injector: "spectator.testnet",
    kind: "Short",
    next: null,
    outcome,
    payout,
    prev: "Long",
    stake: "95000000000000000000000",
    target: duel.b,
  });
  await stub(page, "events", events(null));
  await stub(
    page,
    "duel",
    duelBody({ ...duel, resolved: false, close_at: NS(now + 120_000), outcome: null, chaos: [rec("Pending", "0")] }, null),
  );
  await page.goto("/duel/411");
  const body = page.locator("body");
  await expect(body).toContainText("0.095 in, settles at close");
  await expect(body).not.toContainText("0.000 out"); // a payout of 0 before the finish is not a loss
  await page.unrouteAll();
  await stub(page, "verify", { duel_id: "411", status: "checked", command: "bun run verify-duel 411", counts: { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 }, lines: [] });
  await stub(page, "events", events(null));
  await stub(page, "duel", duelBody({ ...duel, chaos: [rec("Flipped", "90250000000000000000000")] }, null));
  await page.reload();
  await expect(body).toContainText("0.095 in → 0.090 out");
});

test("duel: an open duel is never sent to the verifier", async ({ page }) => {
  const asked: string[] = [];
  await page.route("**/api/verify**", (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 500, json: { error: "must not be called" } });
  });
  await stub(page, "events", events(null));
  await stub(page, "duel", duelBody({ ...duel, resolved: false, close_at: NS(now + 120_000), outcome: null }, null));
  await page.goto("/duel/411");
  await expect(page.locator("body")).toContainText("4 verified       open   checked once the duel resolves");
  await expect(page.locator("body")).toContainText("reproduce        bun run verify-duel 411");
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
});

// ---------------------------------------------------------------- the follower page (values from the live
// nearbuddy-follower2.testnet, with the delayed withdrawal still queued)
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SETTLE_TX = "GBBTWCWevc74eTa24dY26cvpv56qBWGiH7yp5iZ1Nit7";
const follower = {
  at: now,
  account: "nearbuddy-follower2.testnet",
  arena: "arena.nearbuddy-solver.testnet",
  deploy15: true,
  vault: "3596470000000000000000000",
  pending: { amount: "300000000000000000000000", ready_at: NS(now + 600_000) },
  holdings: [
    { token: USDC, amount: "370560" },
    { token: "nep141:wrap.near", amount: "0" },
  ],
  mandates: [
    {
      agent_pk: PK_A,
      model_id: "Qwen/Qwen3.8-27B",
      mandate: {
        allowance: "500000000000000000000000",
        spent: "100000000000000000000000",
        per_tx_cap: "100000000000000000000000",
        allowed_tokens: [USDC],
        expires_at: NS(now + 86_400_000),
        revoked: false,
        min_out_per_near: "3520320",
        revoked_at: "0",
      },
    },
  ],
  fills: [
    {
      tx: SETTLE_TX,
      at_ms: now - 600_000,
      follower: "nearbuddy-follower2.testnet",
      agent_pk: PK_A,
      solver: "nearbuddy-solver.testnet",
      intent_nonce: "1793987081039",
      token: USDC,
      amount_in: "100000000000000000000000",
      amount_out: "370560",
      swap_tx: "stub:1",
    },
  ],
  fills_scan: { from_ms: now - 3_600_000, oldest_ms: now - 4_000_000, txs: 420, complete: true },
  activity: [
    { kind: "request_withdraw", tx: "A7JKJaJoYsv69Ju3jVpJVbYNYfPGQLxZ17u9ZxAx2xpj", at_ms: now - 300_000, amount: "300000000000000000000000" },
    { kind: "withdraw_token", tx: "HG7nez6hggeraoYoPuqnYLmz5uog2kPSyipbaknZS3nK", at_ms: now - 400_000, amount: "370560", token: USDC },
    { kind: "follow", tx: "4fa2aMQftRpGENqiHPRfGKQRDickmydMYTZRxETYompm", at_ms: now - 3_000_000, agent_pk: PK_A },
    { kind: "deposit", tx: "3XafUn3eieEcXmGRunEZdemML2Md2DBAfGqxb4Nezu4F", at_ms: now - 3_100_000, amount: "1000000000000000000000000" },
  ],
};

test("follower: vault, queued withdrawal countdown, holdings, mandate, settled fill and its own calls", async ({ page }) => {
  await stub(page, "follower", follower);
  await page.goto("/follower/nearbuddy-follower2.testnet");
  const body = page.locator("body");
  await expect(body).toContainText("NEARBUDDY FOLLOWER nearbuddy-follower2.testnet");
  await expect(body).toContainText("vault            3.596 NEAR");
  // the fixture's ready_at is fixed when the spec loads; the countdown runs from then
  await expect(body).toContainText(/withdrawal {7}0\.300 NEAR queued {3}ready in \d+:\d\d/);
  await expect(body).toContainText("holding USDC     0.3705 USDC          credited by settled fills");
  await expect(body).toContainText("holding wNEAR    0.0000 wNEAR         credited by settled fills");
  await expect(body).toContainText("a refused call (an early withdraw, say) is not listed");
  await expect(body).toContainText("Qwen3.8-27B             active   cap 0.100  spent 0.100/0.500 NEAR");
  await expect(page.getByRole("link", { name: "Qwen3.8-27B" }).first()).toHaveAttribute("href", `/agent/${encodeURIComponent(PK_A)}`);
  await expect(body).toContainText(" 0.100 NEAR →    0.3705 USDC");
  await expect(page.locator(`a[href$="/txns/${SETTLE_TX}"]`)).toBeVisible();
  await expect(body).toContainText("arena txs read back to its first follow (420 txs)");
  await expect(body).toContainText("ask withdraw  0.300 NEAR");
  await expect(body).toContainText("token out     0.3705 USDC");
  await shot(page, "follower");
});

test("follower: a withdrawal past its delay reads ready; an account that follows nobody says so", async ({ page }) => {
  await stub(page, "follower", {
    ...follower,
    pending: { amount: "300000000000000000000000", ready_at: NS(now - 1000) },
    mandates: [],
    fills: [],
    fills_scan: { from_ms: null, oldest_ms: null, txs: 0, complete: true },
    activity: [],
  });
  await page.goto("/follower/nearbuddy-follower2.testnet");
  const body = page.locator("body");
  await expect(body).toContainText("ready: withdraw() pays it");
  await expect(body).toContainText("follows no agent");
  await expect(body).toContainText("no follow yet: nothing to settle");
  await expect(body).toContainText("no calls to the arena");
});

test("follower: a scan that stopped before the first follow shows a warning row", async ({ page }) => {
  const cut = Date.UTC(2026, 10, 6, 14, 5);
  await stub(page, "follower", {
    ...follower,
    fills_scan: { from_ms: cut - 86_400_000, oldest_ms: cut, txs: 1200, complete: false },
  });
  await page.goto("/follower/nearbuddy-follower2.testnet");
  const warn = page.locator("span.warn", { hasText: "older fills not scanned" });
  await expect(warn).toHaveText("older fills not scanned: arena txs read back to 11-06 14:05 UTC only (1200 txs)");
  await expect(page.locator("span.warn", { hasText: /^warning$/ })).toBeVisible(); // the row's label
  await expect(page.locator("body")).not.toContainText("read back to its first follow");
});
