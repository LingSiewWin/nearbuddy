// The operator runs one keyless match on request: it pairs an idle agent of each chosen model (open_duel, which only
// the arena's owner may call), lets the market move before the models call, asks the oracle for a tick so their
// request shows that move, has the keeper fill the two slots, and resolves the match after its close. One match at a
// time. Everything it reads or sends goes through the injected chains, so the tests run it against a fake.
import type { AgentView } from "../../protocol/src/abi/arena.ts";
import { type Chain, Stop } from "./keeper.ts";

/** A match's length: time to watch the market, the models' calls, and a race to the close. */
export const MATCH_S = 480;
/** How long after the open the tick is asked for. At the open a request reads "move since open: 0" and every model
 *  takes the same side; the oracle serves a cached price for 300 s, so an earlier tick shows no move either. */
export const TICK_AFTER_S = 305;
/** How long to wait for the tick's callback before letting the models call on the open price. */
const TICK_WAIT_S = 40;
const POLL_MS = 5_000;
/** resolve_duel is asked this many times, half a minute apart. */
const RESOLVE_TRIES = 40;
const NEAR = 10n ** 24n;
/** Attached to open_duel, request_tick and resolve_duel: the oracle deposit plus storage; the excess comes back. */
const ORACLE_DEPOSIT = NEAR / 20n;
/** Gas for a call that ends in an oracle call and its callback. */
const ORACLE_TGAS = 300;

export type Phase = "idle" | "opening" | "watching" | "calling" | "racing" | "resolving" | "done" | "failed";
export type Player = { pk: string; model: string };
export type Status = {
  busy: boolean;
  phase: Phase;
  duel: string | null;
  a: Player | null;
  b: Player | null;
  /** ms since the epoch, by this machine's clock. */
  open_at: number | null;
  /** When the models are due to call: the tick is asked for then. */
  call_at: number | null;
  tick_at: number | null;
  close_at: number | null;
  error: string | null;
  /** The transactions this match sent so far, by step. */
  txs: { open?: string; tick?: string; resolve?: string };
};

/** The first idle agent of model `a` and of model `b`, never the same agent twice. */
export function pick(agents: AgentView[], a: string, b: string): [string, string] {
  const idle = agents.filter((x) => x.in_duel === null);
  const first = idle.find((x) => x.model_id === a);
  if (!first) throw new Error(`no idle agent for ${a}`);
  const second = idle.find((x) => x.model_id === b && x.pk !== first.pk);
  if (!second) throw new Error(`no idle agent for ${b}`);
  return [first.pk, second.pk];
}

export interface Deps {
  /** Signs as the arena's owner: open_duel. */
  owner: Chain;
  /** Signs as the keeper account: request_tick, resolve_duel; and every read. */
  chain: Chain;
  keeper: { round(agents: string[]): Promise<number>; settle(): Promise<void> };
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  onPhase?(phase: Phase, status: Status): void;
}

const IDLE: Status = {
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
  txs: {},
};

export class Operator {
  private s: Status = { ...IDLE };
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly d: Deps) {}

  /** A read, retried through a throttled or flaky RPC: five tries, 2 s apart then doubling. */
  private read: Chain["view"] = async (method, args) => {
    for (let i = 0; ; i++) {
      try {
        return await this.d.chain.view(method, args);
      } catch (e) {
        if (i >= 4) throw e;
        await this.d.sleep(2_000 * 2 ** i);
      }
    }
  };

  status(): Status {
    return { ...this.s };
  }

  /** Resolves when no match is running. */
  idle(): Promise<void> {
    return this.running;
  }

  /** Every keyless agent on the arena. */
  async agents(): Promise<AgentView[]> {
    const all: AgentView[] = [];
    for (let from = 0; ; from += 100) {
      const page = await this.read("leaderboard", { from, limit: 100 });
      all.push(...page);
      if (page.length < 100) break;
    }
    const keyless = await Promise.all(all.map((a) => this.read("get_keyless", { agent: a.pk })));
    return all.filter((_, i) => keyless[i] !== null);
  }

  private phase(phase: Phase, more: Partial<Status> = {}) {
    this.s = { ...this.s, ...more, phase };
    this.d.onPhase?.(phase, this.status());
  }

  /** Starts a match between an idle agent of model `a` and one of model `b`; answers its status at once and plays
   *  it out in the background. Throws "busy" while a match runs, or pick()'s reason when no agent is free. */
  async start(a: string, b: string): Promise<Status> {
    if (this.s.busy) throw new Error("busy");
    this.s = { ...IDLE, busy: true };
    let pair: [string, string];
    try {
      pair = pick(await this.agents(), a, b);
    } catch (e) {
      this.s = { ...IDLE, phase: "failed", error: String(e instanceof Error ? e.message : e) };
      throw e;
    }
    this.phase("opening", { a: { pk: pair[0], model: a }, b: { pk: pair[1], model: b } });
    this.running = this.run(pair).catch((e) => {
      this.phase("failed", { busy: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
    });
    return this.status();
  }

  private async until(ms: number) {
    const left = ms - this.d.nowMs();
    if (left > 0) await this.d.sleep(left);
  }

  /** The open duel between exactly `a` and `b`, if the chain has one; with `wait`, looked for over half a minute. */
  private async adopt(a: string, b: string, wait: boolean): Promise<string | null> {
    for (let i = 0; i < (wait ? 6 : 1); i++) {
      if (i) await this.d.sleep(POLL_MS);
      const id = (await this.read("get_agent", { agent_pk: a }).catch(() => null))?.in_duel;
      if (!id) continue;
      const d = await this.read("get_duel", { duel_id: id }).catch(() => null);
      if (d && !d.resolved && d.a === a && d.b === b) return id;
    }
    return null;
  }

  private async run([a, b]: [string, string]): Promise<void> {
    const { owner, chain, keeper, sleep, nowMs } = this.d;
    const open_at = nowMs();
    const close_at = open_at + MATCH_S * 1000;
    const args = { a, b, symbol: "wrap.near", close_at: String(BigInt(close_at) * 1_000_000n) };
    let duel_id: string;
    let open: string | undefined;
    try {
      const opened = await owner.call("open_duel", args, ORACLE_DEPOSIT, ORACLE_TGAS);
      duel_id = String(opened.value);
      open = opened.tx;
    } catch (e) {
      // An RPC can drop the wait for the oracle's receipts after the transaction landed, and a provider that then
      // sends it again is refused "in duel". Either way the duel may exist: look for it, never send a second one.
      const found = await this.adopt(a, b, !/panicked/i.test(String(e)));
      if (!found) throw e;
      duel_id = found;
    }
    this.phase("watching", {
      duel: duel_id,
      open_at,
      close_at,
      call_at: open_at + TICK_AFTER_S * 1000,
      txs: open ? { open } : {},
    });
    await this.until(open_at + TICK_AFTER_S * 1000);

    // a tick that fails or never lands is not fatal: the models then call on the open price
    const tick_at = nowMs();
    const tick = await chain.call("request_tick", { duel_id }, ORACLE_DEPOSIT, ORACLE_TGAS).catch(() => null);
    if (tick) this.s = { ...this.s, txs: { ...this.s.txs, tick: tick.tx } };
    for (let waited = 0; waited < TICK_WAIT_S * 1000; waited += POLL_MS) {
      if ((await this.read("get_tick", { duel_id }).catch(() => null)) !== null) break;
      await sleep(POLL_MS);
    }
    this.phase("calling", { tick_at });
    const lockMs = Number(BigInt((await this.read("duel_lock", { duel_id })) ?? "0") / 1_000_000n);
    while (nowMs() < close_at - lockMs) {
      // a round that dies on a throttled RPC is simply tried again; a keeper stop (budget, outage) ends the calls
      const stop = await keeper.round([a, b]).then(
        () => false,
        (e) => e instanceof Stop,
      );
      if (stop) break;
      await sleep(POLL_MS);
      const d = await this.read("get_duel", { duel_id });
      if (d?.last_intent_a && d.last_intent_b) break;
    }
    await keeper.settle().catch(() => {}); // a keeper stop (budget, outage) ends the calls, not the match

    this.phase("racing");
    await this.until(close_at + POLL_MS);
    this.phase("resolving");
    // The oracle's callback finishes the duel a few blocks after the call, and only with a price stamped after the
    // close: while the oracle is stale the call succeeds and the duel stays open, so it is asked again, for up to
    // about twenty minutes. A read that fails (a throttled RPC) is just another reason to look again.
    let sent: Error | null = null;
    for (let attempt = 0; attempt < RESOLVE_TRIES; attempt++) {
      sent = await chain
        .call("resolve_duel", { duel_id }, ORACLE_DEPOSIT, ORACLE_TGAS)
        .then((r) => {
          this.s = { ...this.s, txs: { ...this.s.txs, resolve: r.tx } };
          return null;
        })
        .catch((e) => e as Error);
      for (let i = 0; i < 6; i++) {
        if ((await this.read("get_duel", { duel_id }).catch(() => null))?.resolved) {
          this.phase("done", { busy: false });
          return;
        }
        await sleep(POLL_MS);
      }
    }
    throw sent ?? new Error(`duel ${duel_id} did not resolve: the oracle has no price after its close yet`);
  }
}
