import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, embed, loadModel, logit, type SentinelModel, score, screen } from "./sentinel.ts";

const tiny: SentinelModel = {
  model: "Qwen/Qwen3-Embedding-0.6B",
  dim: 3,
  bias: 0.5,
  threshold: 0.7,
  weights: [1, -1, 0],
  selftest: { logit: 0 },
};

function replying(embedding: number[], seen: unknown[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("shipped weights reproduce the Python export on the fixed selftest vector", () => {
  const m = loadModel();
  const v = Array.from({ length: m.dim }, (_, i) => Math.sin(i + 1));
  assert.equal(m.weights.length, m.dim);
  assert.ok(Math.abs(logit(v, m) - m.selftest.logit) < 1e-9, `${logit(v, m)} vs ${m.selftest.logit}`);
  assert.ok(m.threshold > 0 && m.threshold < 1);
});

test("score is the logistic of the normalised dot product", () => {
  // [3, 0, 4] has norm 5: z = 3/5 * 1 + 0.5 = 1.1
  assert.equal(score([3, 0, 4], tiny), 1 / (1 + Math.exp(-1.1)));
  assert.equal(score([30, 0, 40], tiny), score([3, 0, 4], tiny));
  assert.throws(() => score([1, 2], tiny), /2 dims, model 3/);
  assert.throws(() => score([0, 0, 0], tiny), /zero embedding/);
});

test("embed posts the model and the cleaned headline, and reads data[0].embedding", async () => {
  const seen: { url: string; body: { model: string; input: string } }[] = [];
  const e = await embed("BREAKING:  BTC   halted https://t.co/x1 now", "k", tiny.model, replying([1, 2, 3], seen));
  assert.deepEqual(e, [1, 2, 3]);
  assert.match(seen[0]!.url, /\/v1\/embeddings$/);
  assert.deepEqual(seen[0]!.body, { model: "Qwen/Qwen3-Embedding-0.6B", input: "BREAKING: BTC halted now" });
});

test("screen flags a score above the threshold and not one below it", async () => {
  const high = await screen("x", { apiKey: "k", model: tiny, fetchFn: replying([1, 0, 0]) }); // z = 1.5
  const low = await screen("x", { apiKey: "k", model: tiny, fetchFn: replying([0, 1, 0]) }); // z = -0.5
  assert.deepEqual([high.flagged, low.flagged], [true, false]);
  assert.equal(high.threshold, 0.7);
});

test("a non-2xx embeddings reply surfaces the status", async () => {
  const fail = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(embed("x", "k", tiny.model, fail), /sentinel embeddings 429: rate limited/);
});

test("cleanText matches the Python clean_text rule", () => {
  assert.equal(cleanText("  a\tb\n https://x.y/z c "), "a b c");
});
