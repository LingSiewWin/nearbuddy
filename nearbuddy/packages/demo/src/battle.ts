// Batch red-team runner for chaos v2 (house testing, testnet): plants a designed corpus of headlines at the keyed
// arena's runner agents, each AGAINST the call the target has just committed, then records every outcome.
//   BATTLE_DIR=<dir> ATTACKER_ID=<acct>.testnet RUNNER_LOGS=<a.log,b.log> DATASET=agents/data/decisions.jsonl \
//     bun packages/demo/src/battle.ts
// <dir>/corpus.json: [{id, family, side, text}]. Writes <dir>/attacks.jsonl (one row per attack once its duel has
// closed: outcomes are decided by reveals, not by the oracle), <dir>/claims.jsonl (claim_chaos once the duel has
// resolved, which can be much later when the oracle is down) and <dir>/inflight.json, <dir>/claims.json (state; a
// restart carries on from them and replays the seeded assignment).
// The target's sealed side is read from the runner's own stdout ("A committed Long nonce ..."): operator knowledge an
// outside attacker does not have, used so every attack is a real trial (lessons: push against what the model does).
// Budgets (env): MAX_ATTACKS 60, MAX_SPEND_NEAR 25, MAX_FEE_NEAR 0.2, STOP_AT (unix s; no new attack after it),
// MAX_MODEL_CALLS 400, MIN_LEFT_S 160. ponytail: model calls are counted from DATASET rows (+1 per judge call), and
// the runner records a row only when a call is revealed or replaced, so this is a lower bound; count the runner logs
// for the true number.
import "../../protocol/src/env.ts";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { teraToGas } from "near-api-js";
import { ARENA, arenaView, explorerTx, fmtNear, loadAccount, NEAR, provider } from "../../protocol/src/chain.ts";

export type Side = "Long" | "Short";
export type Headline = { id: string; family: string; side: Side; text: string };

/** mulberry32: a small seeded PRNG, so the assignment order is reproducible from the recorded seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Per cell (model|prompt) a family queue, reshuffled when empty; within a family the headlines of the needed side
 *  alternate. Deterministic given the seed and the order of calls. */
export class Assigner {
  private queues = new Map<string, string[]>();
  private used = new Map<string, number>();
  private r: () => number;
  constructor(
    private corpus: readonly Headline[],
    seed: number,
  ) {
    this.r = rng(seed);
  }
  next(cell: string, side: Side): Headline {
    let q = this.queues.get(cell);
    if (!q?.length) {
      q = shuffle([...new Set(this.corpus.map((h) => h.family))].sort(), this.r);
      this.queues.set(cell, q);
    }
    const family = q.shift() as string;
    const options = this.corpus.filter((h) => h.family === family && h.side === side);
    if (!options.length) throw new Error(`no ${side} headline in family ${family}`);
    const k = `${family}|${side}`;
    const n = this.used.get(k) ?? 0;
    this.used.set(k, n + 1);
    return options[n % options.length] as Headline;
  }
}

/** The contract's headline rule for ASCII text: 1..=280 bytes, no control characters. */
export function checkCorpus(corpus: readonly Headline[]): void {
  for (const h of corpus) {
    const bytes = Buffer.byteLength(h.text, "utf8");
    if (!h.text.trim() || bytes > 280) throw new Error(`${h.id}: ${bytes} bytes`);
    if (/[^\x20-\x7e]/.test(h.text)) throw new Error(`${h.id}: non-printable-ASCII character`);
    if (h.side !== "Long" && h.side !== "Short") throw new Error(`${h.id}: side ${h.side}`);
  }
}

export type Pair = { log: string; labels: Record<string, { pk8: string; model: string; prompt: string }> };
export type Sealed = Map<string, Side>; // `${duel}|${pk8}` -> side of the latest commitment

/** Read one runner stdout: who plays A and B (pk prefix, model, prompt) and the side of each committed call. */
export function parseRunnerLog(text: string, prompts: { A: string; B: string }, sealed: Sealed): Pair["labels"] {
  const labels: Pair["labels"] = {};
  let duel = "";
  for (const line of text.split("\n")) {
    const pair = line.match(/^pair \S+: A (\S{8}) (\S+), B (\S{8}) (\S+)/);
    if (pair) {
      const [, a8 = "", am = "", b8 = "", bm = ""] = pair;
      labels.A = { pk8: a8, model: am, prompt: prompts.A };
      labels.B = { pk8: b8, model: bm, prompt: prompts.B };
    }
    const d = line.match(/^\[round \d+\] duel (\d+) /);
    if (d?.[1]) duel = d[1];
    const c = line.match(/^ {2}([AB]) committed (Long|Short) nonce /);
    const who = c?.[1] ? labels[c[1]] : undefined;
    if (c && duel && who) sealed.set(`${duel}|${who.pk8}`, c[2] as Side);
  }
  return labels;
}

/** 95% Wilson score interval for k of n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const HARDENED = process.env.HARDENED_PROFILE ?? "hardened-v3";
const pk8 = (pk: string) => pk.slice(0, 8);

async function main() {
  const dir = process.env.BATTLE_DIR as string;
  const attacker = process.env.ATTACKER_ID as string;
  const logs = (process.env.RUNNER_LOGS ?? "").split(",").filter(Boolean);
  const dataset = process.env.DATASET as string;
  if (!dir || !attacker || !logs.length || !dataset) throw new Error("BATTLE_DIR, ATTACKER_ID, RUNNER_LOGS, DATASET");
  const MAX_ATTACKS = Number(process.env.MAX_ATTACKS ?? 60);
  const MAX_SPEND = BigInt(Math.round(Number(process.env.MAX_SPEND_NEAR ?? 25) * 1000)) * (NEAR / 1000n);
  const MAX_FEE = BigInt(Math.round(Number(process.env.MAX_FEE_NEAR ?? 0.2) * 1000)) * (NEAR / 1000n);
  const MAX_CALLS = Number(process.env.MAX_MODEL_CALLS ?? 400);
  const STOP_AT = Number(process.env.STOP_AT ?? Number.MAX_SAFE_INTEGER);
  const EXIT_AT = Number(process.env.EXIT_AT ?? STOP_AT + 1200);
  const MIN_LEFT_S = Number(process.env.MIN_LEFT_S ?? 160);
  const SEED = Number(process.env.SEED ?? 20261114);
  const corpus = JSON.parse(readFileSync(`${dir}/corpus.json`, "utf8")) as Headline[];
  checkCorpus(corpus);
  const assign = new Assigner(corpus, SEED);
  const account = loadAccount(attacker);
  const balance = async () => BigInt((await provider.viewAccount({ accountId: attacker })).amount);
  const startBal = BigInt(process.env.START_BALANCE_YOCTO ?? (await balance()));
  const inflightFile = `${dir}/inflight.json`;
  type Placed = {
    duel_id: string;
    index: number;
    target: string;
    model: string;
    prompt: string;
    cell: string;
    headline_id: string;
    family: string;
    side: Side;
    headline: string;
    sealed_side: Side;
    fee: string;
    inject_tx: string;
    at: string;
    left_s: number;
  };
  const inflight: Placed[] = existsSync(inflightFile) ? JSON.parse(readFileSync(inflightFile, "utf8")) : [];
  const settled: Placed[] = existsSync(`${dir}/attacks.jsonl`)
    ? readFileSync(`${dir}/attacks.jsonl`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  // replay the assigner over every attack already placed, in placement order, so a restart keeps the seeded order
  const before = [...settled, ...inflight].sort((x, y) => x.at.localeCompare(y.at));
  for (const p of before) assign.next(p.cell, p.side);
  let placed = before.length;
  const attacked = new Set(before.map((p) => `${p.duel_id}|${p.target}`));
  const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
  log(`battle ${attacker} on ${ARENA}: ${placed} attacks so far, start balance ${fmtNear(startBal)}`);

  const modelCalls = () => {
    if (!existsSync(dataset)) return 0;
    let n = 0;
    for (const l of readFileSync(dataset, "utf8").split("\n")) {
      if (!l) continue;
      const r = JSON.parse(l);
      n += r.guard?.judge ? 2 : 1; // hardened-v3: the fact-check judge is a second billed call
    }
    return n;
  };
  const rowsByNonce = () => {
    const m = new Map<string, Record<string, unknown>>();
    if (!existsSync(dataset)) return m;
    for (const l of readFileSync(dataset, "utf8").split("\n")) {
      if (!l) continue;
      const r = JSON.parse(l);
      const nonce = r.intent?.nonce;
      if (nonce && (r.revealed_tx || !m.has(nonce))) m.set(nonce, r);
    }
    return m;
  };
  const save = () => writeFileSync(inflightFile, JSON.stringify(inflight, null, 1));

  async function placeAttacks() {
    const now = Date.now() / 1000;
    if (now > STOP_AT || placed >= MAX_ATTACKS) return;
    const spent = startBal - (await balance());
    if (spent >= MAX_SPEND) return log(`budget: spent ${fmtNear(spent)} NEAR`);
    const calls = modelCalls();
    if (calls >= MAX_CALLS) return log(`budget: ${calls} model calls`);
    const sealed: Sealed = new Map();
    const pairs: Pair["labels"][] = [];
    for (const f of logs) {
      if (!existsSync(f)) continue;
      // runner.py: slot A is always the hardened profile and B naive; --swap-prompts swaps the models, not the slots
      pairs.push(parseRunnerLog(readFileSync(f, "utf8"), { A: HARDENED, B: "naive" }, sealed));
    }
    const next = Number((await arenaView("get_config", {})).next_duel);
    for (let id = Math.max(0, next - 4); id < next; id++) {
      const d = await arenaView("get_duel", { duel_id: String(id) });
      if (!d || d.resolved) continue;
      const left = Number(BigInt(d.close_at) / 1_000_000_000n) - Date.now() / 1000;
      if (left < MIN_LEFT_S) continue;
      for (const pk of [d.a, d.b]) {
        if (attacked.has(`${id}|${pk}`) || placed >= MAX_ATTACKS) continue;
        const who = pairs.flatMap((l) => Object.values(l)).find((x) => x.pk8 === pk8(pk));
        const was = sealed.get(`${id}|${pk8(pk)}`);
        if (!who || !was) continue;
        const side: Side = was === "Long" ? "Short" : "Long";
        const cell = `${who.model}|${who.prompt}`;
        const fee = BigInt(await arenaView("chaos_fee", { duel_id: String(id) }));
        if (fee > MAX_FEE) {
          log(`duel ${id} ${pk8(pk)}: fee ${fmtNear(fee)} over cap, skipped`);
          attacked.add(`${id}|${pk}`);
          continue;
        }
        const h = assign.next(cell, side);
        attacked.add(`${id}|${pk}`);
        try {
          const tx = await account.callFunctionRaw({
            contractId: ARENA,
            methodName: "inject_chaos",
            args: { duel_id: String(id), target: pk, kind: side, headline: h.text },
            gas: teraToGas("60"),
            deposit: fee,
          });
          const sv = (tx.status as { SuccessValue?: string }).SuccessValue;
          const index = sv ? Number(Buffer.from(sv, "base64").toString()) : -1;
          placed++;
          inflight.push({
            duel_id: String(id),
            index,
            target: pk,
            model: who.model,
            prompt: who.prompt,
            cell,
            headline_id: h.id,
            family: h.family,
            side,
            headline: h.text,
            sealed_side: was,
            fee: fee.toString(),
            inject_tx: tx.transaction.hash,
            at: new Date().toISOString(),
            left_s: Math.round(left),
          });
          save();
          log(
            `#${placed} duel ${id} ${pk8(pk)} ${cell} sealed ${was} -> push ${side} ${h.id} fee ${fmtNear(fee)} idx ${index} ${explorerTx(tx.transaction.hash)}`,
          );
        } catch (e) {
          log(`inject failed duel ${id} ${pk8(pk)} ${h.id}: ${String(e).slice(0, 200)}`);
        }
      }
    }
  }

  // Outcomes are decided by reveals, before the oracle resolves the duel: record each attack once its duel has closed
  // (every pending headline is then final: a reveal after close is refused), and claim once the duel has resolved,
  // which can be much later when the oracle is down. Claims go to claims.jsonl.
  const claimsFile = `${dir}/claims.json`;
  const toClaim = new Set<string>(existsSync(claimsFile) ? JSON.parse(readFileSync(claimsFile, "utf8")) : []);
  const saveClaims = () => writeFileSync(claimsFile, JSON.stringify([...toClaim]));

  async function claimResolved() {
    for (const id of [...toClaim]) {
      if (!(await arenaView("get_duel", { duel_id: id }))?.resolved) continue;
      let claimTx: string;
      try {
        const tx = await account.callFunctionRaw({
          contractId: ARENA,
          methodName: "claim_chaos",
          args: { duel_id: id },
          gas: teraToGas("30"),
          deposit: 1n,
        });
        claimTx = tx.transaction.hash;
      } catch (e) {
        if (!/nothing to claim/.test(String(e))) {
          log(`claim ${id} failed, retry: ${String(e).slice(0, 160)}`);
          continue;
        }
        claimTx = "nothing to claim";
      }
      const chaos = await arenaView("get_chaos", { duel_id: id });
      const mine = chaos
        .map((c, index) => ({ index, outcome: c.outcome, stake: c.stake, payout: c.payout, target: c.target }))
        .filter((_, i) => chaos[i]?.injector === attacker);
      appendFileSync(
        `${dir}/claims.jsonl`,
        `${JSON.stringify({ duel_id: id, claim_tx: claimTx, records: mine, at: new Date().toISOString() })}\n`,
      );
      log(`claimed duel ${id}: ${claimTx}`);
      toClaim.delete(id);
      saveClaims();
    }
  }

  async function settle() {
    const byDuel = new Map<string, Placed[]>();
    for (const p of inflight) byDuel.set(p.duel_id, [...(byDuel.get(p.duel_id) ?? []), p]);
    for (const [id, ps] of byDuel) {
      const d = await arenaView("get_duel", { duel_id: id });
      if (!d) continue;
      if (!d.resolved && Date.now() < Number(BigInt(d.close_at) / 1_000_000n) + 10_000) continue;
      const chaos = await arenaView("get_chaos", { duel_id: id });
      const rows = rowsByNonce();
      for (const p of ps) {
        const c =
          chaos[p.index] ??
          chaos.find((x) => x.injector === attacker && x.headline === p.headline && x.target === p.target);
        const dec = c?.decided_by ? rows.get(c.decided_by) : undefined;
        const row = {
          ...p,
          arm: c?.arm ?? null,
          // a headline still Pending at close becomes Expired when the duel resolves or is voided
          outcome: c?.outcome === "Pending" ? "Expired" : (c?.outcome ?? "missing"),
          outcome_on_chain_at_record: c?.outcome ?? null,
          prev: c?.prev ?? null,
          next: c?.next ?? null,
          stake: c?.stake ?? null,
          payout: d.resolved ? (c?.payout ?? null) : null,
          decided_by: c?.decided_by ?? null,
          decision_tx: (dec?.revealed_tx as string) ?? null,
          decision_committed_tx: (dec?.committed_tx as string) ?? null,
          decision_size_bps: (dec?.intent as { size_bps?: number })?.size_bps ?? null,
          duel_resolved_at_record: d.resolved,
          duel_winner_b64: d.outcome?.winner ?? null,
          pnl: d.outcome ? { a: d.outcome.pnl_a, b: d.outcome.pnl_b } : null,
          target_slot: p.target === d.a ? "A" : "B",
          settled_at: new Date().toISOString(),
        };
        appendFileSync(`${dir}/attacks.jsonl`, `${JSON.stringify(row)}\n`);
        log(
          `settled duel ${id} ${pk8(p.target)} ${p.headline_id} ${row.arm} ${row.outcome} prev ${row.prev} next ${row.next}`,
        );
        inflight.splice(inflight.indexOf(p), 1);
      }
      toClaim.add(id);
      saveClaims();
      save();
    }
  }

  while (Date.now() / 1000 < EXIT_AT) {
    try {
      await settle();
      await claimResolved();
      await placeAttacks();
    } catch (e) {
      log(`loop: ${String(e).slice(0, 200)}`);
    }
    if (Date.now() / 1000 > STOP_AT && inflight.length === 0 && toClaim.size === 0) break;
    await new Promise((r) => setTimeout(r, 8_000));
  }
  log(
    `battle done: ${placed} attacks, ${inflight.length} unsettled, spent ${fmtNear(startBal - (await balance()))} NEAR`,
  );
}

if (import.meta.main) await main();
