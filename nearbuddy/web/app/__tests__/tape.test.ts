// decode(): one FastNEAR transaction -> one arena event, checked on real testnet transactions (trimmed copies
// of tx.test.fastnear.com /v0/account and /v0/transactions, saved under fixtures/) and on deploy-14 shapes.
// Importing tape.ts pulls in dataset.ts, which reads app/data at module load and falls back to an empty
// dataset when the folder is missing, and near.ts, which only builds an RPC client: no network here.
// Run: `cd web && bun test app/__tests__/tape.test.ts`.
import { describe, expect, test } from "bun:test";
import { decode } from "../api/tape";
import deploy14 from "./fixtures/deploy14.json";
import injectChaos from "./fixtures/inject_chaos.json";
import openDuel from "./fixtures/open_duel.json";
import postIntent from "./fixtures/post_intent.json";
import registerAgent from "./fixtures/register_agent.json";
import resolveDuel from "./fixtures/resolve_duel.json";
import tamper from "./fixtures/tamper.json";

type Fx = { meta: Parameters<typeof decode>[0]; tx: Parameters<typeof decode>[1] };
const run = (f: unknown) => decode((f as Fx).meta, (f as Fx).tx);
const copy = (f: unknown) => structuredClone(f) as Fx;
const SOLVER = "nearbuddy-solver.testnet";
const AGENT_A = "Ul+W6UJKfQlZ9dqSeXa/9wvuXf9CzdhSP59CnqDlf8E=";
const AGENT_B = "8dPZ7znZ6ZopJrCBTF2vWMQTiHhHmuuVpsqnnhe3VgE=";
const COMMITMENT = "ahnw+0vlRRFSS81bDJizjaHuBJo5c1w5MR4QM2AkQ28=";
const args64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const arenaLogs = (f: Fx) => {
  const r = f.tx.receipts.find(
    (x) => x.receipt.receiver_id === "arena.nearbuddy-solver.testnet" && x.execution_outcome.outcome.logs.length,
  );
  if (!r) throw new Error("fixture has no arena log");
  return r.execution_outcome.outcome.logs;
};

describe("decode: real testnet transactions", () => {
  test("post_intent is an intent with the enclave kind from the contract's intent log", () => {
    expect(run(postIntent)).toEqual({
      tx: "4MorVumsiSrncSz3EAKNKR9Kn8JxEyLjnthh3wwJMwe3",
      at: 1_793_978_069_561, // block timestamp ns -> ms, floored
      block: 276503140,
      ok: true,
      signer: SOLVER,
      kind: "intent",
      duel: 347,
      agent: AGENT_B,
      side: "Long",
      size: 5000,
      nonce: "1793974823937",
      tee: 2,
    });
  });

  test("the intent log's tee kind wins over the kind the args claim", () => {
    const f = copy(postIntent);
    const logs = arenaLogs(f);
    logs[0] = (logs[0] as string).replace('"tee":2', '"tee":1');
    expect(run(f)).toMatchObject({ kind: "intent", tee: 1 });
  });

  test("without an intent log the args' tee kind is used", () => {
    const f = copy(postIntent);
    arenaLogs(f).length = 0;
    expect(run(f)).toMatchObject({ kind: "intent", tee: 2 });
  });

  test("the refused tamper tx is a failed intent with no enclave proof, though its args claim kind 2", () => {
    const e = run(tamper);
    expect(e).toMatchObject({
      tx: "4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt",
      ok: false,
      kind: "intent",
      duel: 258,
      agent: AGENT_A,
      side: "Short",
      size: 5000,
      tee: 0,
    });
  });

  test("inject_chaos is an attack carrying the payload hash and the deposit paid; text is joined later", () => {
    expect(run(injectChaos)).toMatchObject({
      kind: "attack",
      ok: true,
      duel: 347,
      target: AGENT_A, // the same key format as an intent's agent, so a reply can be matched to it
      attack: "fake_news",
      hash: "toY3rO6YkReEvYqOo0CzAeJrUBP/XBDiUwLcXr8Puvs=",
      text: null,
      paid: "100000000000000000000000",
    });
  });

  test("open_duel takes the duel id and price from the open_price log and close_at in ms", () => {
    expect(run(openDuel)).toMatchObject({
      kind: "open",
      duel: 347,
      a: AGENT_A,
      b: AGENT_B,
      closeAt: 1_793_978_347_000,
      price: 378033333,
    });
  });

  test("an open_duel without an open_price log takes its id from the method's return value", () => {
    const f = copy(openDuel);
    for (const r of f.tx.receipts) r.execution_outcome.outcome.logs = [];
    expect(run(f)).toMatchObject({ kind: "open", duel: 347, price: null, a: AGENT_A, b: AGENT_B });
  });

  test("a refused open_duel with no log and no return value has no duel id or price", () => {
    const f = copy(openDuel);
    f.meta.is_success = false;
    for (const r of f.tx.receipts) {
      r.execution_outcome.outcome.logs = [];
      (r.execution_outcome.outcome as { status?: unknown }).status = { Failure: {} };
    }
    expect(run(f)).toMatchObject({ kind: "open", ok: false, duel: null, price: null, a: AGENT_A, b: AGENT_B });
  });

  test("resolve_duel reads pnl and prices from the arena's resolve log, ignoring the oracle's own events", () => {
    expect(run(resolveDuel)).toMatchObject({
      kind: "resolve",
      duel: 346,
      pnlA: -8,
      pnlB: -8,
      open: 377386666,
      close: 378033333,
      noReveal: [],
    });
  });

  test("an arena event logged by another receiver is not trusted", () => {
    const f = copy(resolveDuel);
    for (const r of f.tx.receipts) r.receipt.receiver_id = "spoof.testnet";
    expect(run(f)).toMatchObject({ kind: "resolve", duel: 346, pnlA: null, pnlB: null, open: null, close: null });
  });

  test("a malformed EVENT_JSON line is skipped, not thrown", () => {
    const f = copy(resolveDuel);
    arenaLogs(f).unshift("EVENT_JSON:{not json");
    expect(run(f)).toMatchObject({ kind: "resolve", pnlA: -8 });
  });

  test("register_agent (here refused: agent exists) keeps the model and tee flag", () => {
    expect(run(registerAgent)).toMatchObject({
      kind: "register",
      ok: false,
      agent: AGENT_B,
      model: "Qwen/Qwen3.8-27B",
      tee: true,
    });
  });

  test("an unknown method is 'other' with its name; a tx without a function call is a deploy", () => {
    const f = copy(registerAgent);
    const fc = (f.tx.transaction.actions[0] as { FunctionCall: { method_name: string; args: string } }).FunctionCall;
    fc.method_name = "migrate_v12";
    fc.args = args64({});
    expect(run(f)).toMatchObject({ kind: "other", method: "migrate_v12" });
    f.tx.transaction.actions = [{ DeployContract: { code: "AGFzbQ==" } } as never];
    expect(run(f)).toMatchObject({ kind: "other", method: "deploy" });
  });

  test("args that are not base64 JSON decode as empty instead of throwing", () => {
    const f = copy(injectChaos);
    (f.tx.transaction.actions[0] as { FunctionCall: { args: string } }).FunctionCall.args = "%%%";
    expect(run(f)).toMatchObject({ kind: "attack", target: "undefined", hash: "undefined" });
  });
});

// Deploy 14 (commit-reveal, consent) was not live on testnet when these fixtures were taken (no commit_intent,
// reveal_intent or open_duel_consented among the arena's newest 200 transactions), so fixtures/deploy14.json is
// built from the arg and EVENT_JSON formats tape.ts decodes and the deploy-14 contract emits.
describe("decode: deploy 14 shapes (synthetic)", () => {
  test("commit_intent is a commit with no side", () => {
    const e = run(deploy14.commit_intent);
    expect(e).toMatchObject({ kind: "commit", duel: 348, agent: AGENT_A, commitment: COMMITMENT });
    expect(e).not.toHaveProperty("side");
  });

  test("the commit log wins over the args; without a log the args are used", () => {
    const f = copy(deploy14.commit_intent);
    const logs = arenaLogs(f);
    logs[0] = (logs[0] as string).replace('"duel_id":348', '"duel_id":349').replace(COMMITMENT, "from-log");
    expect(run(f)).toMatchObject({ duel: 349, commitment: "from-log" });
    logs.length = 0;
    expect(run(f)).toMatchObject({ kind: "commit", duel: 348, agent: AGENT_A, commitment: COMMITMENT });
  });

  test("reveal_intent is a reveal with the same fields as an intent", () => {
    expect(run(deploy14.reveal_intent)).toEqual({
      tx: "synthetic-reveal-intent",
      at: 1_793_978_430_000,
      block: 276503700,
      ok: true,
      signer: SOLVER,
      kind: "reveal",
      duel: 348,
      agent: AGENT_A,
      side: "Short",
      size: 5000,
      nonce: "1793974823999",
      tee: 2,
    });
  });

  test("open_duel_consented decodes like open_duel", () => {
    expect(run(deploy14.open_duel_consented)).toMatchObject({
      kind: "open",
      duel: 348,
      a: AGENT_A,
      b: AGENT_B,
      closeAt: 1_793_978_700_000,
      price: 377950000,
    });
  });

  test("resolve lists the agents slashed for a commitment they never revealed", () => {
    expect(run(deploy14.resolve_no_reveal)).toMatchObject({
      kind: "resolve",
      duel: 348,
      pnlA: 3,
      pnlB: 0,
      noReveal: [AGENT_B],
    });
  });
});
