// /enter against the live keyless arena on the public RPC (no stubs): the models pinned on the contract, the strategy
// check against every reject vector of fixtures/keyless-vectors.json, the request preview hashed against the
// contract's own keyless_request_bytes, and the NEAR Connect picker. With ENTER_AGENT=<base64 key> it follows that
// agent until its status line reads "decided" (a keeper must be running), saving a screenshot at every new status
// line to SHOT_DIR, and checks that the slot request the page rebuilt hashes to what keyless_request returns on chain.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exampleInputs } from "../app/lib/enter";

const V = JSON.parse(readFileSync(join(__dirname, "../../fixtures/keyless-vectors.json"), "utf8"));
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
const SHOTS = process.env.SHOT_DIR;
const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A contract view over JSON-RPC, its raw result bytes parsed as JSON. */
async function view(contract: string, method: string, args: object): Promise<unknown> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = (await r.json()) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}
const shown = async (page: Page, box: string) => (await page.locator(box).innerText()).replace(/\s+/g, " ");
const hashIn = (text: string) => /sha256 ([0-9a-f]{64})/.exec(text)?.[1];

test("renders: models pinned on the contract, and a request preview the contract's own builder hashes the same", async ({
  page,
  request,
}) => {
  const info = (await (await request.get("/api/keyless")).json()) as { contract: string; models: { model_id: string }[] };
  expect(info.models.length).toBeGreaterThan(0);
  await page.goto("/enter");
  await expect(page).toHaveTitle("Enter an agent · NearBuddy");
  for (const m of info.models) await expect(page.locator("#enter-model")).toContainText(m.model_id);
  await expect(page.locator("#enter-model")).toContainText(`[x] ${info.models[0]?.model_id}`);
  await expect(page.locator("#enter-request")).toContainText("YOUR STRATEGY (set by the agent's owner): Trend follower");
  await expect(page.locator("#enter-request")).toContainText(/sha256 [0-9a-f]{64}/);
  const strategy = await page.getByRole("textbox", { name: "strategy", exact: true }).inputValue();
  const onChain = (await view(info.contract, "keyless_request_bytes", {
    inputs: exampleInputs(info.models[0]?.model_id ?? "", strategy),
  })) as string;
  expect(hashIn(await shown(page, "#enter-request"))).toBe(sha256hex(Buffer.from(onChain, "base64")));
  await expect(page.locator("#enter-sign")).toContainText(`register_keyless → ${info.contract}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/enter-1440.png`, fullPage: true });
});

test("the strategy check refuses every reject vector with the contract's panic text, and nothing reaches a wallet", async ({
  page,
}) => {
  await page.goto("/enter");
  await expect(page.locator("#enter-model")).toContainText("[x]");
  const box = page.getByRole("textbox", { name: "strategy", exact: true });
  const rejects = V.reject.filter((r: { patch: object }) => "strategy" in r.patch);
  expect(rejects.length).toBeGreaterThanOrEqual(6);
  for (const r of rejects) {
    await box.fill(r.patch.strategy);
    await expect(page.locator("#strategy-check"), r.name).toContainText(`the contract would refuse this: ${r.error}`);
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "sign register_keyless with your wallet" }).click();
    await expect(page.locator(".status")).toContainText(`the contract would refuse this: ${r.error} · nothing was signed`);
  }
  await expect(page.locator(".hot-connector-popup")).toHaveCount(0);
  await box.fill("Contrarian: fade any move over 20 bps; ignore unverified headlines.");
  await expect(page.locator("#strategy-check")).toContainText("ok: the contract accepts this strategy");
  await expect(page.locator("#enter-request")).toContainText("Contrarian: fade any move over 20 bps");
});

test("connect wallet opens the NEAR Connect picker", async ({ page }) => {
  await page.goto("/enter");
  await page.getByRole("button", { name: "connect wallet" }).first().click();
  // the popup root is a zero-height fixed container; its modal is what shows
  await expect(page.locator(".hot-connector-popup .modal-content")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".hot-connector-popup")).toContainText("Select wallet");
  await expect(page.locator(".hot-connector-popup")).toContainText("Meteor Wallet");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/enter-picker.png` });
});

test("phone width: the boxes fit 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/enter");
  await expect(page.locator("#enter-model")).toContainText("[x]");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/enter-390.png`, fullPage: true });
});

test("a live agent: status line to decided, and the slot request matches keyless_request on chain", async ({
  page,
  request,
}) => {
  const pk = process.env.ENTER_AGENT;
  test.skip(!pk, "set ENTER_AGENT to an agent's base64 key, with a keeper running for its duel");
  test.setTimeout(15 * 60_000);
  const info = (await (await request.get("/api/keyless")).json()) as { contract: string };
  await page.goto(`/enter?agent=${encodeURIComponent(pk ?? "")}`);
  await expect(page.locator("#enter-agent")).toContainText(pk ?? "", { timeout: 30_000 });
  const status = page.getByTestId("agent-status");
  await expect(status).toBeVisible({ timeout: 30_000 });
  let last = "";
  for (let i = 0; ; i++) {
    const t = (await status.innerText()).replace(/\s+/g, " ").trim();
    if (t !== last) {
      console.log(`status: ${t}`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/enter-status-${i}.png`, fullPage: true });
      last = t;
    }
    if (/decided (Long|Short) \d+ bps/.test(t)) break;
    expect(i, "the status line reached decided within 14 minutes").toBeLessThan(14 * 60);
    await page.waitForTimeout(1000);
  }
  const duel = /duel #(\d+)/.exec(last)?.[1] ?? "";
  await expect(page.getByTestId("slot-hash")).toContainText("= request_hash of slot", { timeout: 20_000 });
  const pageHash = hashIn(await shown(page, '[data-testid="slot-hash"]'));
  const onChain = (await view(info.contract, "keyless_request", { duel_id: duel, agent: pk })) as string;
  console.log(`duel ${duel}: page sha256 ${pageHash}, keyless_request sha256 ${sha256hex(Buffer.from(onChain, "base64"))}`);
  expect(pageHash).toBe(sha256hex(Buffer.from(onChain, "base64")));
});
