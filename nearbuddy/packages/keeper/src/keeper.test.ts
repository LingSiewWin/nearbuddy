import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { b64, unhex } from "../../protocol/src/index.ts";
import { Budget, type ModelError, NearAi, Outage } from "./nearai.ts";
import { teeProofFrom } from "./tee.ts";

const KEY = "sk-test-secret";
const fake = (answers: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (u: string | URL | Request, init?: RequestInit) => answers(String(u), init)) as typeof fetch;

test("models: prices per token, refuses a missing model and never echoes the key", async () => {
  const list = {
    data: [
      { id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.00000008", completion: "0.0000005" } },
      { id: "other", pricing: {} },
    ],
  };
  const ai = new NearAi(
    KEY,
    "http://x/v1",
    fake(() => new Response(JSON.stringify(list))),
  );
  assert.deepEqual(
    await ai.models(["z-ai/glm-5.3-flash"]),
    new Map([["z-ai/glm-5.3-flash", { prompt: 8e-8, completion: 5e-7 }]]),
  );
  await assert.rejects(ai.models(["other"]), /not listed with a price: other/);
  const down = new NearAi(
    KEY,
    "http://x/v1",
    fake(() => new Response(`bad key ${KEY}`, { status: 500 })),
  );
  await assert.rejects(
    down.models([]),
    (e: ModelError) => e.down && !e.message.includes(KEY) && /HTTP 500/.test(e.message),
  );
});

test("complete keeps the exact response bytes; a 5xx or no answer is an outage, a 429 is not", async () => {
  const body = new TextEncoder().encode('{"model":"m"}');
  const out = '{"id":"chat-1","usage":{"prompt_tokens":10,"completion_tokens":3}}  ';
  let sent: unknown;
  const ai = new NearAi(
    KEY,
    "http://x/v1",
    fake((_, init) => {
      sent = init?.body;
      return new Response(out);
    }),
  );
  const c = await ai.complete(body);
  assert.equal(sent, body);
  assert.equal(new TextDecoder().decode(c.response), out, "trailing bytes kept: the enclave hashed them");
  assert.deepEqual([c.chatId, c.usage.prompt_tokens, c.usage.completion_tokens], ["chat-1", 10, 3]);
  const o = new Outage(2);
  for (const status of [502, 429, 503]) {
    const e = await new NearAi(
      KEY,
      "http://x/v1",
      fake(() => new Response("x", { status })),
    )
      .complete(body)
      .catch((e) => e);
    o.failed("m", e as ModelError);
  }
  assert.match(o.down() ?? "", /model m: 2 calls in a row/);
  o.answered("m");
  assert.equal(o.down(), null);
  const dead = new NearAi(
    KEY,
    "http://x/v1",
    fake(() => Promise.reject(new TypeError("fetch failed"))),
  );
  assert.equal(((await dead.complete(body).catch((e) => e)) as ModelError).status, null);
});

test("signature retries a miss, then gives up with null", async () => {
  let n = 0;
  const rec = { text: "t", signature: "s", signing_address: "a" };
  const ai = new NearAi(
    KEY,
    "http://x/v1",
    fake(() => (++n < 3 ? new Response("", { status: 404 }) : new Response(JSON.stringify(rec)))),
  );
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  assert.deepEqual(await ai.signature("chat-1", "m", 6, sleep), rec);
  assert.deepEqual(waits, [1500, 3000]);
  const never = new NearAi(
    KEY,
    "http://x/v1",
    fake(() => new Response("", { status: 404 })),
  );
  assert.equal(await never.signature("chat-1", "m", 3, sleep), null);
});

test("budget: sums the jsonl, refuses a call whose worst case crosses the cap", () => {
  const file = join(mkdtempSync(join(tmpdir(), "keeper-")), "spend.jsonl");
  const b = new Budget(0.001, file);
  const p = { prompt: 1e-7, completion: 1e-6 };
  assert.equal(b.admit(Budget.worst(p, 2000, 600)), null); // 0.0002 + 0.0006
  b.record({
    model: "m",
    tokens_in: 1000,
    tokens_out: 500,
    usd: Budget.usd(p, { prompt_tokens: 1000, completion_tokens: 500 }),
    purpose: "slot 1/a/0",
  });
  assert.ok(Math.abs(b.spent() - 0.0006) < 1e-12);
  assert.match(b.admit(Budget.worst(p, 2000, 600)) ?? "", /cap \$0.001/);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
});

// Real record from NEAR AI Cloud, 2026-11-06 (packages/protocol/src/intent.test.ts).
const REAL = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  req: "eddd4548b2b35d65de9b8617c6632b09d487606c74c02fbab9bac1ee349901e3",
  res: "c4f9c6e53487a744f1687c06d00d09735e7f2a8c4215a019f97150ff6c2dc09f",
  signature:
    "3b24456ee898ba8e684c10e7ad373d42e88d9c26ce4cf1a47187f2112dd66eac6aea43f8df942829c3836b3cedc1119ad7efc48c3d12b29056129a366fbe620b",
  signing_address: "236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c",
};

test("teeProofFrom: a real enclave record becomes the contract's kind-2 proof; anything else is refused", () => {
  const [req, res] = [unhex(REAL.req), unhex(REAL.res)];
  const rec = {
    text: `${REAL.model}:${REAL.req}:${REAL.res}`,
    signature: REAL.signature,
    signing_address: REAL.signing_address,
    signing_algo: "ed25519",
    signature_kind: "provider_tee",
  };
  const p = teeProofFrom(rec, REAL.model, req, res);
  assert.deepEqual([p.kind, p.signer, p.request_hash], [2, b64.enc(unhex(REAL.signing_address)), b64.enc(req)]);
  assert.throws(() => teeProofFrom(rec, "Qwen/Qwen3.8-27B", req, res), /does not match our bytes/);
  assert.throws(() => teeProofFrom({ ...rec, signature_kind: "gateway" }, REAL.model, req, res), /kind 2/);
  const bad = `${REAL.signature.slice(0, -2)}00`;
  assert.throws(() => teeProofFrom({ ...rec, signature: bad }, REAL.model, req, res), /does not verify/);
});
