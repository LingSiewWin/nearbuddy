// The operator's HTTP surface: status is open to read, starting a match needs the shared secret, two known models
// and a free operator.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentView } from "../../protocol/src/abi/arena.ts";
import type { Status } from "./operator.ts";
import { handle, type Ops } from "./serve.ts";

const DS = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const QW = "Qwen/Qwen3.8-27B";
const idle: Status = {
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
const agent = (pk: string, model_id: string, in_duel: string | null) => ({ pk, model_id, in_duel }) as AgentView;
function ops(over: Partial<Ops> = {}): Ops & { started: string[][] } {
  const started: string[][] = [];
  return {
    started,
    status: () => idle,
    agents: async () => [agent("d1", DS, null), agent("q1", QW, "4")],
    start: async (a, b) => {
      started.push([a, b]);
      return { ...idle, busy: true, phase: "opening" };
    },
    ...over,
  };
}
const post = (body: unknown, secret?: string) => ({
  method: "POST",
  path: "/match",
  secret,
  body: JSON.stringify(body),
});

test("GET /status answers the status and each model with whether an agent of it is idle", async () => {
  const r = await handle(ops(), "s3", { method: "GET", path: "/status", secret: undefined, body: "" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ...idle,
    models: [
      { id: DS, idle: true },
      { id: QW, idle: false },
    ],
  });
});

test("POST /match without the secret, or with a wrong one, is refused and starts nothing", async () => {
  const o = ops();
  assert.equal((await handle(o, "s3", post({ a: DS, b: QW }))).status, 401);
  assert.equal((await handle(o, "s3", post({ a: DS, b: QW }, "nope"))).status, 401);
  assert.deepEqual(o.started, []);
});

test("POST /match with a model no agent runs is a 400", async () => {
  const o = ops();
  const r = await handle(o, "s3", post({ a: DS, b: "x/unknown" }, "s3"));
  assert.equal(r.status, 400);
  assert.deepEqual(o.started, []);
});

test("POST /match with a body that is not two model ids is a 400", async () => {
  assert.equal((await handle(ops(), "s3", { ...post({}, "s3"), body: "not json" })).status, 400);
  assert.equal((await handle(ops(), "s3", post({ a: DS }, "s3"))).status, 400);
});

test("POST /match starts the match and answers its status", async () => {
  const o = ops();
  const r = await handle(o, "s3", post({ a: DS, b: QW }, "s3"));
  assert.equal(r.status, 200);
  assert.deepEqual(o.started, [[DS, QW]]);
  assert.equal((r.body as Status).phase, "opening");
});

test("a busy operator answers 409, and a model with no idle agent 409 with the reason", async () => {
  const busy = ops({
    start: async () => {
      throw new Error("busy");
    },
  });
  assert.equal((await handle(busy, "s3", post({ a: DS, b: QW }, "s3"))).status, 409);
  const none = ops({
    start: async () => {
      throw new Error(`no idle agent for ${QW}`);
    },
  });
  const r = await handle(none, "s3", post({ a: DS, b: QW }, "s3"));
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: `no idle agent for ${QW}` });
});

test("anything else is a 404", async () => {
  assert.equal((await handle(ops(), "s3", { method: "GET", path: "/", secret: undefined, body: "" })).status, 404);
});

test("GET /status still answers, with the last models it read, while the chain cannot be read", async () => {
  let down = false;
  const o = ops({
    agents: async () => {
      if (down) throw new Error("Rate limits exceeded");
      return [agent("d1", DS, null)];
    },
  });
  await handle(o, "s3", { method: "GET", path: "/status", secret: undefined, body: "" });
  down = true;
  const r = await handle(o, "s3", { method: "GET", path: "/status", secret: undefined, body: "" });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { models: unknown }).models, [{ id: DS, idle: true }]);
});
