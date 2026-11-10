// Permissionless keeper for keyless agents (arena/src/keyless.rs). Per round, for every keyless agent in an open
// duel: open a decision slot when one is due (the duel's first decision, or a paid headline the latest slot did not
// carry), rebuild the slot's request bytes from chain views alone and check them against the slot's request_hash,
// post them to NEAR AI Cloud, fetch the enclave's signature record and `submit_completion` (one step: the request is
// public and the model close to deterministic at temperature 0, so there is nothing to hide). The keeper holds a
// NEAR account key for gas, never an agent key: the enclave signature is the agent's custody.
//
// Every wait has a deadline on the chain clock and an outcome when it passes, and agents run side by side, so one
// slow slot never blocks another agent or the next round: the model call and the signature fetch must finish before
// the slot's deadline (slot TTL or the intent lock, whichever is first, less a margin); past it the slot is skipped
// (its spend logged, nothing sent) and the next one opens once the TTL has run out. A slot another keeper filled
// first ("slot taken") is logged and left.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentView,
  ArenaCalls,
  ArenaViews,
  Chaos,
  Duel,
  KeylessAgent,
  Slot,
} from "../../protocol/src/abi/arena.ts";
import { b64 } from "../../protocol/src/index.ts";
import {
  KEYLESS_MAX_TOKENS,
  type KeylessInputs,
  keylessRequest,
  parseDecision,
  SLOT_TTL_NS,
} from "../../protocol/src/keyless.ts";
import { Budget, ModelError, type NearAi, type Outage, type Pricing } from "./nearai.ts";
import { teeProofFrom } from "./tee.ts";

/** The chain as the keeper uses it; `nearChain` in index.ts is the real one, tests pass a fake. */
export interface Chain {
  /** An arena view; the method name picks args and result from the generated ABI types (abi/arena.json). */
  view<M extends keyof ArenaViews>(method: M, args: ArenaViews[M]["args"]): Promise<ArenaViews[M]["result"]>;
  /** An arena call signed by the keeper; throws with the contract's panic text when the receipt fails. */
  call<M extends keyof ArenaCalls>(
    method: M,
    args: ArenaCalls[M]["args"],
    deposit: bigint,
    tgas: number,
  ): Promise<{ tx: string; value: ArenaCalls[M]["result"] }>;
  /** Timestamp of the latest final block (ns): any transaction sent now executes at or after it. */
  now(): Promise<bigint>;
}

const S = 1_000_000_000n;
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const short = (pk: string) => pk.slice(0, 8);

/** The inputs slot `s` froze, read back from chain views: what `keyless_request` builds the bytes from. */
export function slotInputs(agent: AgentView, k: KeylessAgent, d: Duel, s: Slot, chaos: Chaos[] | null): KeylessInputs {
  const headlines: KeylessInputs["headlines"] = [];
  for (let i = 0; i < s.seen; i++)
    if (s.heads & (1 << i)) {
      const c = chaos?.[i];
      if (!c) throw new Error(`get_chaos(${d.id}) has no record ${i}`);
      headlines.push({ text: c.headline, arm: c.arm });
    }
  if (d.open_price === null) throw new Error(`duel ${d.id} has no open price`);
  return {
    template_version: k.template,
    model_id: agent.model_id,
    strategy: k.strategy,
    symbol: d.symbol,
    open_price: d.open_price,
    price: s.price,
    seconds_left: String((BigInt(d.close_at) - BigInt(s.opened_at)) / S),
    duel_id: d.id,
    seq: s.seq,
    nonce: s.nonce,
    headlines,
  };
}

/** A paid headline pending at `agent` that `s` did not carry (planted after it opened). */
const freshHeadline = (chaos: Chaos[] | null, agent: string, s: Slot) =>
  (chaos ?? []).some((c, i) => i >= s.seen && c.target === agent && c.outcome === "Pending");

type Row = Record<string, unknown> & { event: string };

/** Stops the keeper: the budget cap or a model outage. */
export class Stop extends Error {
  constructor(
    msg: string,
    readonly code: number,
  ) {
    super(msg);
  }
}

export interface KeeperOpts {
  /** Seconds kept free before each deadline for the transaction to land. */
  marginS: number;
  /** jsonl of every slot event: open, submit (with the response), skip, drop. */
  logFile: string;
  print?: (line: string) => void;
}

export class Keeper {
  private readonly keyless = new Map<string, boolean>();
  private readonly print: (line: string) => void;

  constructor(
    private readonly chain: Chain,
    private readonly ai: NearAi,
    private readonly budget: Budget,
    private readonly outage: Outage,
    private readonly opts: KeeperOpts,
  ) {
    this.print = opts.print ?? ((l) => console.log(`[keeper ${new Date().toISOString().slice(11, 19)}] ${l}`));
  }

  private record(row: Row) {
    mkdirSync(dirname(this.opts.logFile), { recursive: true });
    appendFileSync(this.opts.logFile, `${JSON.stringify({ ts: Date.now() / 1000, ...row })}\n`);
  }

  /** Every keyless agent on the arena: the leaderboard lists every agent, `get_keyless` tells which are keyless
   *  (cached: a key never changes kind). ponytail: one view per new agent; an event index past a few thousand. */
  async discover(): Promise<string[]> {
    const all: string[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.chain.view("leaderboard", { from, limit: 100 });
      all.push(...page.map((a) => a.pk));
      if (page.length < 100) break;
    }
    for (const pk of all)
      if (!this.keyless.has(pk)) this.keyless.set(pk, (await this.chain.view("get_keyless", { agent: pk })) !== null);
    return all.filter((pk) => this.keyless.get(pk));
  }

  /** Agents with a step still running (a model call, a signature fetch, a transaction): the next round leaves them
   *  alone, so one slow slot never holds up another agent. */
  private readonly busy = new Map<string, Promise<void>>();
  private stopped: Stop | null = null;

  /** One pass over `agents`: starts a step for each agent in an open duel that has none running and returns how many
   *  are in one. Throws `Stop` once the keeper must stop (budget cap, model outage). */
  async round(agents: string[]): Promise<number> {
    if (this.stopped) throw this.stopped;
    const live: { agent: string; av: AgentView; duel: Duel }[] = [];
    for (const agent of agents) {
      const av = await this.chain.view("get_agent", { agent_pk: agent });
      if (!av?.in_duel) continue;
      const duel = await this.chain.view("get_duel", { duel_id: av.in_duel });
      if (duel && !duel.resolved && duel.open_price !== null) live.push({ agent, av, duel });
    }
    const idle = live.filter((l) => !this.busy.has(l.agent));
    if (!idle.length) return live.length;
    // health and prices (free), before any billed call this round
    let prices: Map<string, Pricing>;
    try {
      prices = await this.ai.models([...new Set(idle.map((l) => l.av.model_id))]);
      this.outage.answered("GET /v1/models");
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      this.outage.failed("GET /v1/models", e);
      this.print(`unhealthy: ${e.message}; no model call this round`);
      this.stopIfDown();
      return live.length;
    }
    for (const { agent, av, duel } of idle) {
      const step = this.agent(agent, av, duel, prices.get(av.model_id)!)
        .catch((e) => {
          if (e instanceof Stop) this.stopped ??= e;
          else this.print(`duel ${duel.id} agent ${short(agent)}: error ${String(e).slice(0, 300)}`);
        })
        .finally(() => this.busy.delete(agent));
      this.busy.set(agent, step);
    }
    return live.length;
  }

  /** Wait for every running step; throws the `Stop` one of them hit. */
  async settle(): Promise<void> {
    await Promise.all(this.busy.values());
    if (this.stopped) throw this.stopped;
  }

  private stopIfDown() {
    const why = this.outage.down();
    if (!why) return;
    this.stopped ??= new Stop(`${why}; no more model calls`, 75);
    throw this.stopped;
  }

  /** One agent's step: open a slot when a decision is due, or take an open one, and fill it. */
  private async agent(agent: string, av: AgentView, d: Duel, price: Pricing): Promise<void> {
    const tag = `duel ${d.id} agent ${short(agent)}`;
    const [lock, slot, now] = await Promise.all([
      this.chain.view("duel_lock", { duel_id: d.id }),
      this.chain.view("get_slot", { duel_id: d.id, agent }),
      this.chain.now(),
    ]);
    const lockNs = BigInt(lock ?? "0");
    const margin = BigInt(this.opts.marginS) * S;
    if (now + lockNs + margin >= BigInt(d.close_at)) return; // no decision lands inside the intent lock
    const chaos = await this.chain.view("get_chaos", { duel_id: d.id }).catch(() => null);
    let s = slot;
    const ends = s ? BigInt(s.opened_at) + SLOT_TTL_NS : 0n;
    if (!(s && !s.response_hash && now + margin < ends)) {
      // due: the duel's first decision, a headline the last slot did not carry, or a slot that expired unfilled
      const due = !s || freshHeadline(chaos, agent, s) || (!s.response_hash && now >= ends);
      if (!due) return;
      const r = await this.chain.call("open_slot", { duel_id: d.id, agent }, 0n, 100);
      s = r.value;
      this.print(`${tag}: opened slot ${s.seq} (price ${s.price}, ${popcount(s.heads)} headline(s)), tx ${r.tx}`);
      this.record({ event: "open", duel_id: d.id, agent, seq: s.seq, tx: r.tx, request_hash: s.request_hash });
    }
    await this.keep(tag, agent, av, d, s, price, lockNs, chaos);
  }

  private async keep(
    tag: string,
    agent: string,
    av: AgentView,
    d: Duel,
    s: Slot,
    price: Pricing,
    lockNs: bigint,
    chaosNow: Chaos[] | null,
  ): Promise<void> {
    const at = `${tag} seq ${s.seq}`;
    const margin = BigInt(this.opts.marginS) * S;
    const deadline = min(BigInt(s.opened_at) + SLOT_TTL_NS, BigInt(d.close_at) - lockNs) - margin;
    // the request bytes, from chain views only, checked against the hash the contract stored
    const k = await this.chain.view("get_keyless", { agent });
    if (!k) throw new Error(`${at}: get_keyless returned null`);
    const chaos = s.heads ? (chaosNow ?? (await this.chain.view("get_chaos", { duel_id: d.id }))) : null;
    const req = keylessRequest(slotInputs(av, k, d, s, chaos));
    const reqHash = sha256(req);
    if (b64.enc(reqHash) !== s.request_hash) {
      this.print(`${at}: SKIP rebuilt request hash ${b64.enc(reqHash)} != slot ${s.request_hash}; not paying for it`);
      this.record({ event: "drop", duel_id: d.id, agent, seq: s.seq, why: "request hash mismatch" });
      return;
    }
    const refused = this.budget.admit(Budget.worst(price, req.length, KEYLESS_MAX_TOKENS));
    if (refused) throw new Stop(refused, 1);
    const left = async () => Number((deadline - (await this.chain.now())) / 1_000_000n);
    let ms = await left();
    if (ms < 5_000) return this.skip(at, d, agent, s, "slot window closed before the model call");
    let c: Awaited<ReturnType<NearAi["complete"]>>;
    try {
      c = await this.ai.complete(req, ms);
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      this.outage.failed(av.model_id, e);
      this.skip(at, d, agent, s, e.message);
      return this.stopIfDown();
    }
    this.outage.answered(av.model_id);
    const usd = Budget.usd(price, c.usage);
    this.budget.record({
      model: av.model_id,
      tokens_in: c.usage.prompt_tokens,
      tokens_out: c.usage.completion_tokens,
      usd,
      purpose: `keyless ${d.id}/${short(agent)}/${s.seq}`,
      chat_id: c.chatId,
    });
    const resHash = sha256(c.response);
    const rec = await this.ai.signature(c.chatId, av.model_id);
    if (!rec) return this.skip(at, d, agent, s, `no enclave signature record for ${c.chatId}`);
    let proof: ReturnType<typeof teeProofFrom>;
    try {
      proof = teeProofFrom(rec, av.model_id, reqHash, resHash);
    } catch (e) {
      return this.skip(at, d, agent, s, `enclave record refused: ${(e as Error).message}`);
    }
    const pinned = await this.chain.view("get_model_signer", { signer: proof.signer });
    if (pinned !== av.model_id)
      return this.skip(at, d, agent, s, `enclave key ${proof.signer} is pinned to ${pinned ?? "no model"}`);
    const decision = parseDecision(c.response, s.heads !== 0);
    ms = await left();
    if (ms < 0) return this.skip(at, d, agent, s, "slot window closed during the model call");
    let r: { tx: string };
    try {
      r = await this.chain.call(
        "submit_completion",
        {
          duel_id: d.id,
          agent,
          seq: s.seq,
          response: b64.enc(c.response),
          signer: proof.signer,
          signature: proof.signature,
        },
        0n,
        150,
      );
    } catch (e) {
      const why = /slot taken|stale slot|slot expired|intent lock|duel closed/.exec(String(e))?.[0];
      if (!why) throw e;
      return this.skip(at, d, agent, s, `submit refused: ${why}`);
    }
    this.record({
      event: "submit",
      duel_id: d.id,
      agent,
      seq: s.seq,
      tx: r.tx,
      model: av.model_id,
      chat_id: c.chatId,
      request_hash: s.request_hash,
      response_hash: proof.response_hash,
      signer: proof.signer,
      decision,
      usd,
      response: new TextDecoder().decode(c.response),
    });
    const said = decision ? `${decision.side} ${decision.size_bps} bps` : "no readable decision";
    this.print(`${at}: submitted (${said}), $${usd.toFixed(5)}, tx ${r.tx}`);
  }

  private skip(at: string, d: Duel, agent: string, s: Slot, why: string) {
    this.print(`${at}: SKIP ${why}`);
    this.record({ event: "skip", duel_id: d.id, agent, seq: s.seq, why });
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const popcount = (n: number) => n.toString(2).replace(/0/g, "").length;
