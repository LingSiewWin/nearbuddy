// The keeper's slot lifecycle against a fake arena (the keyless.rs rules it depends on) and a fake NEAR AI Cloud
// that signs like the enclave: first decision, hold until the lock, reveal early for a new headline, the budget stop
// and the deadline skip.
import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ArenaCalls, ArenaViews, Chaos, Slot } from "../../protocol/src/abi/arena.ts";
import { b64, hex } from "../../protocol/src/index.ts";
import { keyFromSeed, pkOf, teeText, verify } from "../../protocol/src/intent.ts";
import { keylessRequest, parseDecision, SLOT_TTL_NS } from "../../protocol/src/keyless.ts";
import { type Chain, Keeper, Stop, slotInputs } from "./keeper.ts";
import { Budget, NearAi, Outage } from "./nearai.ts";

const S = 1_000_000_000n;
const MODEL = "z-ai/glm-5.3-flash";
const AGENT = b64.enc(new Uint8Array(32).fill(9));
const enclave = keyFromSeed("11".repeat(32));
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** keyless.rs as the keeper meets it: open_slot, commit_completion, reveal_completion and their views. */
class FakeArena implements Chain {
  t = 1_000n * S;
  close = 1_300n * S;
  lock = 60n * S;
  slot: Slot | null = null;
  seq = 1n;
  chaos: Chaos[] = [];
  calls: string[] = [];
  revealed: { side: string; size_bps: number } | null = null;
  agent = {
    pk: AGENT,
    model_id: MODEL,
    in_duel: "4",
    owner: "o.testnet",
    bond: "1",
    alpha_bps: 0,
    shield: 0,
    tee: true,
  };
  duel = {
    id: "4",
    a: AGENT,
    b: "x",
    symbol: "wrap.near",
    open_price: "366000000",
    close_at: String(this.close),
    resolved: false,
  };
  keyless = { strategy: "Fade every headline.", template: 1, next_seq: "1" };
  async now() {
    return this.t;
  }
  async view<M extends keyof ArenaViews>(m: M, args: ArenaViews[M]["args"]): Promise<ArenaViews[M]["result"]> {
    const a = args as Record<string, unknown>;
    const v: Record<string, unknown> = {
      leaderboard: [this.agent],
      get_keyless: a.agent === AGENT ? this.keyless : null,
      get_agent: this.agent,
      get_duel: this.duel,
      duel_lock: String(this.lock),
      get_slot: this.slot,
      get_chaos: this.chaos,
      is_tee_signer: a.signer === pkOf(enclave),
      keyless_commit_bond: "300",
    };
    return v[m] as ArenaViews[M]["result"];
  }
  async call<M extends keyof ArenaCalls>(
    m: M,
    args: ArenaCalls[M]["args"],
    deposit: bigint,
  ): Promise<{ tx: string; value: ArenaCalls[M]["result"] }> {
    const a = args as Record<string, unknown>;
    this.calls.push(m);
    const tx = `tx${this.calls.length}`;
    if (m === "open_slot") {
      const heads = this.chaos.reduce(
        (h, c, i) => (c.target === AGENT && c.outcome === "Pending" ? h | (1 << i) : h),
        0,
      );
      const s: Slot = {
        seq: String(this.seq++),
        nonce: b64.enc(new Uint8Array(32).fill(Number(this.seq))),
        opened_at: String(this.t),
        price: "366100000",
        seen: this.chaos.length,
        heads,
        request_hash: "",
        commit: null,
        revealed: false,
        side: null,
        size_bps: 0,
      };
      s.request_hash = b64.enc(
        sha(keylessRequest(slotInputs(this.agent as never, this.keyless, this.duel as never, s, this.chaos))),
      );
      this.slot = s;
      return { tx, value: s as ArenaCalls[M]["result"] };
    }
    const s = this.slot!;
    if (m === "commit_completion") {
      assert.ok(this.t < BigInt(s.opened_at) + SLOT_TTL_NS && this.t + this.lock < this.close, "commit window");
      assert.ok(deposit >= 300n, "keeper bond");
      const text = teeText(2, MODEL, b64.dec(s.request_hash), b64.dec(a.response_hash as string));
      assert.ok(verify(a.signer as string, text, a.signature as string), "bad tee signature");
      s.commit = {
        response_hash: a.response_hash as string,
        signer: a.signer as string,
        committer: "k",
        bond: String(deposit),
        committed_at: String(this.t),
      };
      return { tx, value: undefined as ArenaCalls[M]["result"] };
    }
    if (m === "reveal_completion") {
      if (this.t >= this.close) throw new Error("reveal_completion failed: Smart contract panicked: duel closed");
      const res = b64.dec(a.response as string);
      assert.equal(b64.enc(sha(res)), s.commit!.response_hash, "response mismatch");
      s.revealed = true;
      this.revealed = parseDecision(res, s.heads !== 0);
      return { tx, value: undefined as ArenaCalls[M]["result"] };
    }
    throw new Error(`unexpected ${m}`);
  }
}

/** NEAR AI Cloud stand-in: answers long, or short when the request carries a headline; signs like the enclave. */
function fakeAi(delayMs = 0) {
  const records = new Map<string, unknown>();
  let n = 0;
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith("/models"))
      return new Response(
        JSON.stringify({ data: [{ id: MODEL, pricing: { prompt: "0.00000008", completion: "0.0000005" } }] }),
      );
    if (url.endsWith("/chat/completions")) {
      await new Promise((ok, no) => {
        const t = setTimeout(ok, delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          no(new DOMException("timeout", "TimeoutError"));
        });
      });
      const body = init!.body as Uint8Array;
      const user = JSON.parse(new TextDecoder().decode(body)).messages[1].content as string;
      const side = user.includes("injection, unverified") ? "short" : "long";
      const id = `chat-${++n}`;
      const content = JSON.stringify({ direction: side, size_bps: 4000, reasoning: "test" });
      const out = new TextEncoder().encode(
        JSON.stringify({
          id,
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 900, completion_tokens: 60 },
        }),
      );
      const text = new TextDecoder().decode(teeText(2, MODEL, sha(body), sha(out)));
      records.set(id, {
        text,
        signature: hex(new Uint8Array(sign(null, Buffer.from(text), enclave))),
        signing_address: hex(b64.dec(pkOf(enclave))),
        signing_algo: "ed25519",
        signature_kind: "provider_tee",
      });
      return new Response(out);
    }
    const id = /signature\/([^?]+)/.exec(url)?.[1];
    const rec = id && records.get(decodeURIComponent(id));
    return rec ? new Response(JSON.stringify(rec)) : new Response("", { status: 404 });
  }) as typeof fetch;
  return new NearAi("k", "http://ai/v1", fetchFn);
}

function setup(cap = 1.5, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "keeper-"));
  const arena = new FakeArena();
  const lines: string[] = [];
  const budget = new Budget(cap, join(dir, "spend.jsonl"));
  const k = new Keeper(arena, fakeAi(delayMs), budget, new Outage(3), {
    marginS: 10,
    logFile: join(dir, "keeper.jsonl"),
    print: (l) => lines.push(l),
  });
  const step = async () => {
    await k.round([AGENT]);
    await k.settle();
  };
  return { dir, arena, k, lines, budget, step };
}

test("first decision, held to the lock, revealed early for a headline, then again inside the lock", async () => {
  const { dir, arena, k, step, budget } = setup();
  await step();
  assert.deepEqual(arena.calls, ["open_slot", "commit_completion"]);
  assert.equal(k.held.size, 1);
  arena.t += 20n * S;
  await step();
  assert.equal(arena.calls.length, 2, "committed and no headline: held, nothing sent");
  arena.chaos.push({
    target: AGENT,
    outcome: "Pending",
    headline: "NEAR <b>hacked</b> & drained",
    arm: "Cue",
  } as Chaos);
  await step();
  assert.deepEqual(arena.calls.slice(2), ["reveal_completion"], "revealed at once for the new headline");
  assert.deepEqual(arena.revealed, { side: "Long", size_bps: 4000 });
  await step();
  assert.deepEqual(arena.calls.slice(3), ["open_slot", "commit_completion"]);
  assert.equal(arena.slot!.heads, 1, "the new slot carries the headline");
  arena.t = arena.close - 30n * S; // inside the 60 s lock
  await step();
  assert.deepEqual(arena.calls.slice(5), ["reveal_completion"]);
  assert.deepEqual(arena.revealed, { side: "Short", size_bps: 1000 }, "capped under a paid headline");
  await step();
  assert.equal(arena.calls.length, 6, "no new slot inside the lock");
  assert.equal(readFileSync(join(dir, "spend.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.ok(Math.abs(budget.spent() - 2 * (900 * 8e-8 + 60 * 5e-7)) < 1e-12);
  // a restarted keeper reads nothing left to reveal
  assert.equal(
    new Keeper(arena, fakeAi(), budget, new Outage(), { marginS: 10, logFile: join(dir, "keeper.jsonl") }).held.size,
    0,
  );
});

test("a restarted keeper still reveals the response it committed", async () => {
  const { dir, arena, step, budget } = setup();
  await step();
  const again = new Keeper(arena, fakeAi(), budget, new Outage(), {
    marginS: 10,
    logFile: join(dir, "keeper.jsonl"),
    print: () => {},
  });
  assert.equal(again.held.size, 1);
  arena.t = arena.close - 5n * S;
  await again.round([AGENT]);
  await again.settle();
  assert.deepEqual(arena.calls, ["open_slot", "commit_completion", "reveal_completion"]);
});

test("a model call that runs past the commit deadline skips the slot", { timeout: 15_000 }, async () => {
  const { arena, step, lines } = setup(1.5, 60_000);
  arena.t = arena.close - arena.lock - 16n * S; // 6 s to the deadline (lock + 10 s margin)
  await step();
  assert.deepEqual(arena.calls, ["open_slot"]);
  assert.match(lines.join("\n"), /seq 1: SKIP POST \/chat\/completions: no answer \(TimeoutError\)/);
});

test("the budget cap stops the keeper before a call that could cross it", async () => {
  const { arena, k, step } = setup(0.0001);
  await assert.rejects(step(), (e: Stop) => e instanceof Stop && e.code === 1 && /cap \$0.0001/.test(e.message));
  assert.deepEqual(arena.calls, ["open_slot"]);
  await assert.rejects(k.round([AGENT]), Stop, "stays stopped");
});
