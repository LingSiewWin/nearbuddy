// The web's duel verifier against the CLI it copies (analysis/verify_duel.ts): the checks section byte for byte,
// the protocol slice output for output on real intents, and GET /api/verify replaying real testnet duels saved
// with `bun run verify-duel <id> --save` through a fake RPC and FastNEAR, line for line against the CLI's checkDuel.
// Run: `cd web && bun test app`.
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as web from "../lib/protocol";
import { arenaCalls, checkDuel, collect, duelCalls, type Evidence, incomplete, type Line, state } from "../lib/verify";
import { NET } from "../network";

const ROOT = `${import.meta.dir}/../../..`; // nearbuddy/
const CLI = `${ROOT}/analysis/verify_duel.ts`;
// dynamic, so web's tsc does not follow packages/protocol's .ts-extension imports
const proto = {
  ...(await import(`${ROOT}/packages/protocol/src/index.ts`)),
  ...(await import(`${ROOT}/packages/protocol/src/intent.ts`)),
} as typeof web;
const cli = (await import(CLI)) as { checkDuel: (e: Evidence) => Line[] };
// #401 recast as a deploy-17 duel (none exists on testnet yet), with get_chaos records typed by the ABI
const v17 = (await import(`${ROOT}/analysis/fixtures/verify_duel_v17.ts`)) as { asDeploy17: (e: Evidence) => Evidence };
// the route's arena id: another test file may mock ../api/near for the whole bun process
const { ARENA } = await import("../api/near");
// the CLI line: names the arena only when it is not the network default (as here under another file's mock)
const cmd = (id: string) => `${ARENA === NET.arena ? "" : `ARENA_CONTRACT=${ARENA} `}bun run verify-duel ${id}`;
const fixture = (id: string): Evidence => {
  const raw = readFileSync(`${ROOT}/analysis/fixtures/verify_duel_${id}.json`, "utf8");
  const from = (JSON.parse(raw) as Evidence).arena;
  const e = JSON.parse(raw.replaceAll(from, ARENA)) as Evidence;
  // the call args are base64 JSON (the oracle callback names the arena as sender_id): rewrite those too
  for (const t of e.txs)
    for (const r of t.receipts)
      for (const a of r.receipt.receipt.Action?.actions ?? [])
        if (typeof a === "object" && a.FunctionCall)
          a.FunctionCall.args = Buffer.from(
            Buffer.from(a.FunctionCall.args, "base64").toString().replaceAll(from, ARENA),
          ).toString("base64");
  return e;
};

describe("drift", () => {
  test("the checks section is analysis/verify_duel.ts byte for byte", () => {
    const from = "// ---------------------------------------------------------------- the evidence (all public)\n";
    const to = "// ---------------------------------------------------------------- collecting the evidence";
    const section = (path: string) => {
      const s = readFileSync(path, "utf8");
      expect(s).toContain(from);
      return s.slice(s.indexOf(from), s.indexOf(to));
    };
    const ours = section(`${import.meta.dir}/../lib/verify.ts`);
    expect(ours.length).toBeGreaterThan(10_000);
    expect(ours).toBe(section(CLI)); // edit analysis/verify_duel.ts, then copy the section to web/app/lib/verify.ts
  });
  test("the protocol slice gives packages/protocol's bytes on real intents and proofs", () => {
    for (const id of ["373", "363", "395", "401"]) {
      const e = fixture(id);
      for (const c of duelCalls(arenaCalls(e.txs, e.arena), e.duel_id).intents) {
        const s = c.args.signed as { intent: web.Intent; signature: string };
        expect(web.b64.enc(web.intentMessage(s.intent))).toBe(proto.b64.enc(proto.intentMessage(s.intent)));
        expect(web.verify(s.intent.agent_pk, web.intentMessage(s.intent), s.signature)).toBe(true);
        // change one field at a time: the bytes still match packages/protocol (a field-order slip in the hand-written
        // borsh fails here), and the real signature no longer verifies over them
        const i = s.intent;
        const flip = (b: string) => {
          const x = web.b64.dec(b);
          x[0]! ^= 1; // one bit: a reversal would leave the stubs' all-zero proof_hash as it was
          return web.b64.enc(x);
        };
        const forgeries: web.Intent[] = [
          { ...i, agent_pk: flip(i.agent_pk) },
          { ...i, duel_id: String(BigInt(i.duel_id) + 1n) },
          { ...i, side: i.side === "Long" ? "Short" : "Long" },
          { ...i, size_bps: i.size_bps === 1 ? 2 : i.size_bps - 1 },
          { ...i, nonce: String(BigInt(i.nonce) + 1n) },
          { ...i, expires_at: String(BigInt(i.expires_at) + 1n) },
          { ...i, proof_hash: flip(i.proof_hash) },
        ];
        for (const f of forgeries) {
          expect(web.b64.enc(web.intentMessage(f))).toBe(proto.b64.enc(proto.intentMessage(f)));
          expect(web.verify(i.agent_pk, web.intentMessage(f), s.signature)).toBe(false);
        }
        const p = c.args.tee as web.TeeProof | undefined;
        if (!p) continue;
        const [req, res] = [web.b64.dec(p.request_hash), web.b64.dec(p.response_hash)];
        expect(web.proofHash(req, res)).toBe(proto.proofHash(req, res));
        for (const kind of [1, 2] as const)
          expect(web.hex(web.teeText(kind, "org/model", req, res))).toBe(
            proto.hex(proto.teeText(kind, "org/model", req, res)),
          );
      }
    }
  });
});

// ---------------------------------------------------------------- GET /api/verify on a fake RPC + FastNEAR
// Replays the deploy-15 fixtures (#395 the first deploy-15 duel, #401 red-team self-chaos): they carry every input
// the collector reads (state at the closing block, duel_lock, the pools around each injection, the open block).

let ev: Evidence = fixture("395");
let fetches: string[] = [];
let blockFails = false;
let rpcDown = false;
let chaosDown = false;
const enc = (v: unknown) => ({ result: { result: Array.from(Buffer.from(JSON.stringify(v))) } });
const prevOf = (blk: string) => `PREV:${blk}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.includes("fastnear.com/v0")) {
    fetches.push(url.endsWith("/account") ? "account" : "transactions");
    if (url.endsWith("/account"))
      return Response.json({
        account_txs: ev.txs.map((t) => ({
          transaction_hash: t.transaction.hash,
          tx_block_timestamp: BigInt(Math.round(Number(t.receipts[0]!.execution_outcome.block_timestamp))).toString(),
        })),
      });
    return Response.json({ transactions: ev.txs.filter((t) => body.tx_hashes.includes(t.transaction.hash)) });
  }
  if (!url.includes("rpc")) return realFetch(input, init);
  fetches.push(body.method);
  if (body.method === "block")
    return blockFails
      ? Response.json({ error: "pruned" })
      : Response.json({ result: { header: { prev_hash: prevOf(body.params.block_id) } } });
  const p = body.params as { request_type: string; method_name: string; args_base64: string; block_id?: string };
  const calls = duelCalls(arenaCalls(ev.txs, ev.arena), ev.duel_id);
  const openBlk = calls.open?.block_hash;
  if (p.request_type === "view_account") {
    const ob = ev.open_block;
    if (ob && p.block_id === prevOf(openBlk!)) return Response.json({ result: { storage_usage: ob.storage_before } });
    if (ob && p.block_id === openBlk) return Response.json({ result: { storage_usage: ob.storage_after } });
    return Response.json({ error: "unknown block" });
  }
  const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString()) as Record<string, string>;
  if (p.method_name === "is_tee_signer") return Response.json(enc(ev.pinned[args.signer!] ?? false));
  if (p.method_name === "get_chaos")
    return Response.json(ev.chaos && !chaosDown ? enc(ev.chaos) : { error: "no such method" });
  if (p.method_name === "duel_lock") return Response.json(ev.lock_ns ? enc(ev.lock_ns) : { error: "no such method" });
  const fin = calls.closing?.block_hash;
  if (p.block_id && p.method_name === "get_duel")
    for (const [blk, [pre, post]] of Object.entries(ev.chaos_pools ?? {})) {
      if (p.block_id === prevOf(blk)) return Response.json(enc({ ...ev.now.duel, pool: pre }));
      if (p.block_id === blk && blk !== fin) return Response.json(enc({ ...ev.now.duel, pool: post }));
    }
  if (p.block_id === openBlk && p.method_name === "get_config" && ev.open_block)
    return Response.json(enc(ev.open_block.config));
  const st = !p.block_id ? ev.now : p.block_id === prevOf(fin!) ? ev.before : p.block_id === fin ? ev.after : null;
  if (!st) return Response.json({ error: "unknown block" });
  switch (p.method_name) {
    case "get_duel":
      if (rpcDown) return Response.json({ error: "rate limited" });
      return Response.json(enc(st.duel));
    case "get_config":
      return Response.json(enc(st.config));
    case "get_agent":
      return Response.json(enc(args.agent_pk === st.duel?.a ? st.a : st.b));
    case "get_no_reveal":
      return Response.json(st.no_reveal ? enc(st.no_reveal) : { error: "no such method" });
  }
  return Response.json({ error: `no view ${p.method_name}` });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { GET } = await import("../api/verify/route");
const get = async (id: string) => (await GET(new Request(`http://x/api/verify?duel=${id}`))).json();
/** The CLI's lines on the same evidence, minus what only differs by where it ran: the scan-window INFO line, and
 *  the completion bytes the CLI checks against the local dataset (the web has no dataset: SKIP). */
const comparable = (lines: Line[]) => lines.filter((l) => l.check !== "duel" && !l.check.endsWith("completion bytes"));
/** What the web collects from these txs: the saved `others` counted the whole scan window, the replay only the duel's
 *  own txs, so the open block's other-receipt count is recounted the way the collector counts it. */
const asReplayed = (e: Evidence): Evidence => {
  const blk = duelCalls(arenaCalls(e.txs, e.arena), e.duel_id).open?.block_hash;
  if (!e.open_block || !blk) return { ...e, rows: {} };
  const others = arenaCalls(e.txs, e.arena).filter((c) => c.ok && c.block_hash === blk).length - 1;
  return { ...e, rows: {}, open_block: { ...e.open_block, others } };
};

describe("GET /api/verify", () => {
  // B1, while #401 is not yet cached: right after resolution FastNEAR may not have indexed the close callback
  test("a close receipt not indexed yet is degraded, kept 60 s only, then checked again", async () => {
    const t0 = Date.now();
    const full = fixture("401");
    const close = duelCalls(arenaCalls(full.txs, full.arena), "401").closing!;
    ev = { ...full, txs: full.txs.filter((t) => t.transaction.hash !== close.tx) };
    fetches = [];
    const j = await get("401");
    expect(j.degraded).toBe(true);
    const payout = j.lines.find((l: Line) => l.check === "payout");
    expect(payout.result).toBe("SKIP");
    expect(payout.detail).toContain("not in the scanned txs yet");
    const n = fetches.length;
    await get("401"); // inside the 60 s: the same result, no read
    expect(fetches.length).toBe(n);
    ev = full; // the index caught up
    setSystemTime(new Date(t0 + 61_000));
    const k = await get("401");
    setSystemTime();
    expect(k.degraded).toBe(false);
    expect(k.lines.find((l: Line) => l.check === "payout").result).toBe("PASS");
  });

  test("a failed check (RPC rate limit) answers 502 and is kept 45 s, so polls do not rescan", async () => {
    const t0 = Date.now();
    ev = fixture("395");
    rpcDown = true;
    fetches = [];
    expect((await GET(new Request("http://x/api/verify?duel=555"))).status).toBe(502);
    const n = fetches.length;
    expect(n).toBeGreaterThan(0);
    expect((await GET(new Request("http://x/api/verify?duel=555"))).status).toBe(502);
    expect(fetches.length).toBe(n); // kept: no new read
    rpcDown = false;
    setSystemTime(new Date(t0 + 46_000));
    await GET(new Request("http://x/api/verify?duel=555"));
    setSystemTime();
    expect(fetches.length).toBeGreaterThan(n); // tried again once the 45 s passed
  });

  // while #395 is not yet cached: every past-block read fails (pruned, no archival answer), then recovers
  test("a failed past-block read is degraded: payout SKIPs, kept 60 s only, then checked again", async () => {
    const t0 = Date.now();
    ev = fixture("395");
    blockFails = true;
    fetches = [];
    const j = await get("395");
    expect(j.degraded).toBe(true);
    expect(j.lines.find((l: Line) => l.check === "payout").result).toBe("SKIP");
    blockFails = false;
    const n = fetches.length;
    await get("395"); // inside the 60 s: the degraded result, no read
    expect(fetches.length).toBe(n);
    setSystemTime(new Date(t0 + 61_000));
    const k = await get("395");
    setSystemTime();
    expect(k.degraded).toBe(false);
    expect(k.lines.find((l: Line) => l.check === "payout").result).toBe("PASS");
  });

  for (const id of ["395", "401"])
    test(`#${id}: the same lines as the CLI, no FAIL, completion bytes SKIP without the dataset`, async () => {
      ev = fixture(id);
      fetches = [];
      const j = await get(id);
      expect(j.status).toBe("checked");
      const want = cli.checkDuel(asReplayed(ev));
      expect(comparable(j.lines)).toEqual(comparable(want));
      expect(j.lines.filter((l: Line) => l.result === "FAIL")).toEqual([]);
      const bytes = (ls: Line[]) => ls.filter((l) => l.check.endsWith("completion bytes"));
      expect(bytes(j.lines).map((l: Line) => l.result)).toEqual(bytes(want).map(() => "SKIP"));
      expect(j.command).toBe(cmd(id));
      expect(j.degraded).toBe(false);
      // resolved and complete: kept, no second read
      const before = fetches.length;
      expect((await get(id)).lines).toEqual(j.lines);
      expect(fetches.length).toBe(before);
    });

  // the route keeps #401 from the tests above, so the deploy-17 recast runs through the web's own collector
  test("deploy 17 (#401 recast): the collector reads get_chaos; the same lines as the CLI, no FAIL", async () => {
    ev = v17.asDeploy17(fixture("401"));
    const got = await collect(ARENA, "401", await state(ARENA, "401"));
    expect(got.chaos).toEqual(ev.chaos!);
    const lines = checkDuel(got);
    expect(comparable(lines)).toEqual(comparable(cli.checkDuel(asReplayed(ev))));
    expect(lines.filter((l) => l.result === "FAIL")).toEqual([]);
    for (const check of ["payout", "chaos settlement", "shield", "chaos records", "injection deposits"])
      expect([check, lines.find((l) => l.check === check)?.result]).toEqual([check, "PASS"]);
    expect(incomplete(got)).toBe(false);
    // a failed get_chaos read: no verdict on the settlement, and not final
    chaosDown = true;
    const down = await collect(ARENA, "401", await state(ARENA, "401"));
    chaosDown = false;
    expect(down.chaos).toBeNull();
    expect(incomplete(down)).toBe(true);
    expect(checkDuel(down).find((l) => l.check === "payout")?.result).toBe("SKIP");
  });

  test("an open duel is never verified: no FastNEAR scan, no cache", async () => {
    const base = fixture("395");
    ev = {
      ...base,
      duel_id: "999",
      now: { ...base.now, duel: { ...base.now.duel!, id: "999", resolved: false, outcome: null } },
    };
    fetches = [];
    const j = await get("999");
    expect(j).toMatchObject({ duel_id: "999", status: "open", command: cmd("999") });
    expect(fetches).not.toContain("account");
    await get("999");
    expect(fetches.filter((f) => f === "query").length).toBeGreaterThan(4); // read again: an open duel is not kept
  });

  test("bad ids are refused before any read", async () => {
    fetches = [];
    expect((await GET(new Request("http://x/api/verify?duel=abc"))).status).toBe(400);
    expect(fetches).toEqual([]);
  });
});
