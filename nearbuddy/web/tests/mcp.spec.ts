// The MCP endpoint against a running app: the legacy initialize handshake, the stateless 2026-07-28 form with
// its required headers, the tool list and real tool calls. Reads the chain over the public RPC like
// api.spec.ts, so a run needs the network; the agent key comes from arena_now rather than a fixture.
import { type APIRequestContext, expect, test } from "@playwright/test";

const MODERN = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };
const ACCEPT = "application/json, text/event-stream";
let id = 0;

/** One 2026-07-28 request with the headers that revision requires. */
async function rpc(request: APIRequestContext, method: string, params: Record<string, unknown> = {}) {
  const r = await request.post("/mcp", {
    headers: {
      accept: ACCEPT,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    data: { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } },
  });
  expect(r.headers()["content-type"]).toContain("application/json");
  return { status: r.status(), body: await r.json() };
}

/** tools/call; the result's text block must be the same JSON as its structuredContent. */
async function call(request: APIRequestContext, name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await rpc(request, "tools/call", { name, arguments: args });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body.result.resultType).toBe("complete");
  if (!body.result.isError) expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
  return body.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent: any };
}

let pk: string;

test("initialize negotiates a legacy version; GET is 405 with a description", async ({ request }) => {
  const init = async (protocolVersion: string) =>
    (
      await (
        await request.post("/mcp", {
          headers: { accept: ACCEPT },
          data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {} } },
        })
      ).json()
    ).result;
  const r = await init("2025-06-18");
  expect(r.protocolVersion).toBe("2025-06-18");
  expect(r.capabilities.tools).toEqual({});
  expect(r.serverInfo.name).toBe("nearbuddy-arena");
  expect((await init("2099-01-01")).protocolVersion).toBe("2025-11-25");
  const note = await request.post("/mcp", {
    headers: { accept: ACCEPT, "mcp-protocol-version": "2025-06-18" },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(note.status()).toBe(202);
  const get = await request.get("/mcp");
  expect(get.status()).toBe(405);
  expect(get.headers().allow).toBe("POST");
  expect(await get.text()).toContain("claude mcp add --transport http nearbuddy");
});

test("tools/list: eight tools with valid input schemas", async ({ request }) => {
  const { status, body } = await rpc(request, "tools/list");
  expect(status).toBe(200);
  const { tools, resultType, ttlMs } = body.result;
  expect(resultType).toBe("complete");
  expect(ttlMs).toBeGreaterThan(0);
  expect(tools.map((t: { name: string }) => t.name)).toEqual([
    "arena_now",
    "recent_events",
    "decisions",
    "decision_bytes",
    "agent_record",
    "duel_record",
    "which_agent_to_follow",
    "follow_transaction",
  ]);
  for (const t of tools) {
    const s = t.inputSchema;
    expect(s.type, t.name).toBe("object");
    expect(s.additionalProperties, t.name).toBe(false);
    for (const k of s.required) expect(Object.keys(s.properties), t.name).toContain(k);
    for (const [k, p] of Object.entries(s.properties) as [string, { type: string; pattern?: string }][]) {
      expect(["string", "integer", "number", "boolean"], `${t.name}.${k}`).toContain(p.type);
      if (p.pattern) expect(() => new RegExp(p.pattern as string)).not.toThrow();
    }
    expect(t.annotations.readOnlyHint, t.name).toBe(true);
    expect(t.description.length, t.name).toBeGreaterThan(20);
  }
});

test("arena_now returns standings and recent results", async ({ request }) => {
  const r = await call(request, "arena_now");
  expect(r.isError).toBeFalsy();
  const s = r.structuredContent;
  expect(s.network).toBe("testnet");
  expect(s.standings.length).toBeGreaterThan(0);
  pk = s.standings[0].agent;
});

test("decisions filters attacked rows and honours limit", async ({ request }) => {
  const r = await call(request, "decisions", { attacked: true, limit: 2 });
  expect(r.structuredContent.count).toBe(2);
  for (const row of r.structuredContent.rows) {
    expect(row.attack).toBeTruthy();
    expect(["resisted", "named", "fell", "unmoved"]).toContain(row.verdict);
  }
});

test("agent_record reads a real agent; a bad key is a tool error", async ({ request }) => {
  const r = await call(request, "agent_record", { pk });
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent.agent).toBe(pk);
  expect(r.structuredContent.attacks.faced).toBeGreaterThanOrEqual(0);
  const bad = await call(request, "agent_record", { pk: "not-a-key" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]?.text).toContain("pk must be");
});

test("follow_transaction builds deposit + follow with a positive USDC price floor; nothing is sent", async ({
  request,
}) => {
  // its own key: a failed earlier test restarts the worker, which resets the module's pk
  pk ??= (await call(request, "arena_now", {})).structuredContent.standings[0].agent as string;
  const r = await call(request, "follow_transaction", { pk, cap_near: 0.1, allowance_near: 0.5, days: 3 });
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  const f = r.structuredContent;
  expect(f.calls.map((c: { method: string }) => c.method)).toEqual(["deposit", "follow"]);
  expect(f.calls[0].attach_near).toBe(0.51); // the allowance plus storage headroom
  expect(f.scope).toContain("Short");
  const m = f.calls[1].args.mandate;
  expect(f.calls[1].args.agent_pk).toBe(pk);
  expect(m.per_tx_cap).toBe("100000000000000000000000");
  expect(m.allowance).toBe("500000000000000000000000");
  expect(m.allowed_tokens[0]).toMatch(/^nep141:/);
  expect(Number(m.min_out_per_near)).toBeGreaterThan(0);
  expect(m.min_out_per_near).toBe(f.price_floor.min_out_per_near);
  expect(f.near_cli[1]).toContain(`follow json-args '${JSON.stringify(f.calls[1].args)}'`);
  const over = await call(request, "follow_transaction", { pk, cap_near: 2, allowance_near: 1 });
  expect(over.isError).toBe(true);
  expect(over.content[0]?.text).toContain("cap_near");
});

test("protocol errors: unknown tool, missing headers, unsupported version", async ({ request }) => {
  const unknown = await rpc(request, "tools/call", { name: "nope", arguments: {} });
  expect(unknown.body.error.code).toBe(-32602);
  const bare = await request.post("/mcp", {
    headers: { accept: ACCEPT, "mcp-protocol-version": MODERN },
    data: { jsonrpc: "2.0", id: 99, method: "tools/list", params: { _meta: meta } },
  });
  expect(bare.status()).toBe(400);
  expect((await bare.json()).error.code).toBe(-32020);
  const old = await request.post("/mcp", {
    headers: { accept: ACCEPT, "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
    data: {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/list",
      params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
    },
  });
  expect(old.status()).toBe(400);
  expect((await old.json()).error.data.supported).toContain(MODERN);
});
