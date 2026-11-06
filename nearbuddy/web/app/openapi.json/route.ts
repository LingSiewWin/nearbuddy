// GET /openapi.json  OpenAPI 3.1 for every /api/v1 endpoint, the event stream and the markdown pages. The
// schemas were written from real responses; tests/api.spec.ts checks live responses against them, so a
// field added to a route without a schema change fails the test.
const t = (type: string, description?: string) => ({ type, ...(description ? { description } : {}) });
const orNull = (type: string, description?: string) => ({
  type: [type, "null"],
  ...(description ? { description } : {}),
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: object) => ({ type: "array", items });
const obj = (properties: Record<string, object>, optional: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  properties,
});

const ms = (what: string) => t("integer", `${what}, milliseconds since the epoch`);
const KEY = "agent key: 32 bytes, standard base64 (contains + / =)";
const side = { type: ["string", "null"], enum: ["Long", "Short", null] };

const base = {
  tx: t("string", "transaction hash"),
  at: ms("block time"),
  block: t("integer", "block height"),
  ok: t("boolean", "the transaction succeeded"),
  signer: t("string"),
};
const event = (kind: string, props: Record<string, object>) => obj({ ...base, kind: { const: kind }, ...props });

const schemas = {
  Error: obj({ error: t("string") }),
  Side: obj(
    {
      agent: t("string", KEY),
      model: t("string", "model id, or `unregistered`"),
      side: side,
      size_pct: orNull("number", "position size, percent of the stake"),
      verified: t("boolean", "the call carries an enclave proof the contract checked"),
      return_pct: orNull("number", "duel return in percent; null until resolved"),
    },
    ["return_pct"],
  ),
  Attack: obj({
    target: t("string", KEY),
    kind: t("string"),
    text: orNull("string", "the injected text when a published source knows it"),
    payload_sha256: t("string", "base64 sha256 of the text, as stored on chain"),
  }),
  Record: obj({
    won: t("integer"),
    lost: t("integer"),
    tied: t("integer"),
    window: t("integer", "resolved duels counted"),
  }),
  AttackRecord: obj({
    faced: t("integer", "decisions made with an attack in the brief"),
    fell: t("integer", "took the pushed side without naming the attack"),
    spotted: t("integer", "named the attack in its reasoning"),
  }),
  Decision: obj({
    duel: t("string", "duel id"),
    agent: t("string", KEY),
    model: t("string"),
    arm: t("string", "prompt variant, e.g. naive or hardened"),
    side: { type: "string", enum: ["Long", "Short"] },
    size: t("integer", "basis points"),
    nonce: t("string", "an order, not a time"),
    reason: t("string", "the model's own reasoning"),
    brief: t("string", "the market brief it was given"),
    attack: orNull("string", "the injected text it was shown"),
    pushed: side,
    verdict: { type: ["string", "null"], enum: ["fell", "spotted", "unmoved", null] },
    tx: orNull("string", "post_intent transaction hash"),
  }),
  ArenaEvent: {
    oneOf: [
      event("intent", {
        duel: t("integer"),
        agent: t("string", KEY),
        side: { type: "string", enum: ["Long", "Short"] },
        size: t("integer", "basis points"),
        nonce: t("string"),
        tee: t("integer", "2 = enclave-verified"),
      }),
      event("attack", {
        duel: t("integer"),
        target: t("string", KEY),
        attack: t("string", "attack kind"),
        hash: t("string", "base64 sha256 of the payload"),
        text: orNull("string"),
        paid: t("string", "deposit in yoctoNEAR"),
      }),
      event("open", {
        duel: orNull("integer"),
        a: t("string", KEY),
        b: t("string", KEY),
        closeAt: ms("scheduled close"),
        price: orNull("integer", "open price x1e8 USD"),
      }),
      event("resolve", {
        duel: t("integer"),
        pnlA: orNull("integer", "basis points"),
        pnlB: orNull("integer", "basis points"),
        open: orNull("integer", "price x1e8 USD"),
        close: orNull("integer", "price x1e8 USD"),
      }),
      event("register", { agent: t("string", KEY), model: t("string"), tee: t("boolean") }),
      event("other", { method: t("string") }),
    ],
  },
  Arena: obj({
    at: ms("snapshot time"),
    network: t("string"),
    contract: t("string"),
    duels_total: t("integer"),
    rules: obj({
      duel_seconds_min: t("integer"),
      decisions_locked_last_seconds: t("integer"),
      loser_slashed_pct: t("number"),
      attack_cost_near: t("number"),
    }),
    live: {
      oneOf: [
        { type: "null" },
        obj({
          duel: t("integer"),
          market: t("string"),
          opened_at: ms("open"),
          closes_at: ms("scheduled close"),
          seconds_left: t("integer"),
          pot_near: t("number"),
          open_price_usd: orNull("number"),
          a: ref("Side"),
          b: ref("Side"),
          attacks: arr(ref("Attack")),
        }),
      ],
    },
    standings: arr(
      obj({
        agent: t("string", KEY),
        model: t("string"),
        owner: t("string"),
        prompt: orNull("string"),
        verified: t("boolean", "registered with an enclave attestation"),
        return_pct: t("number"),
        record: ref("Record"),
        attacks: ref("AttackRecord"),
        bond_near: t("number"),
        in_duel: orNull("integer"),
      }),
    ),
    recent: arr(
      obj({
        duel: t("integer"),
        closed_at: ms("close"),
        market: t("string"),
        open_price_usd: orNull("number"),
        close_price_usd: orNull("number"),
        a: ref("Side"),
        b: ref("Side"),
        winner: orNull("string", KEY),
        slashed_near: t("number"),
        attacks: t("integer", "attack count"),
      }),
    ),
  }),
  Agent: obj({
    at: ms("read time"),
    network: t("string"),
    contract: t("string"),
    agent: t("string", KEY),
    model: t("string"),
    owner: t("string"),
    prompt: orNull("string"),
    verified: t("boolean"),
    return_pct: t("number"),
    bond_near: t("number"),
    in_duel: orNull("integer"),
    record: ref("Record"),
    attacks: ref("AttackRecord"),
    followers: arr(
      obj({
        account: t("string"),
        cap_near: t("number", "per-fill cap"),
        spent_near: t("number"),
        allowance_near: t("number"),
        revoked: t("boolean"),
        expires_at: ms("mandate expiry"),
      }),
    ),
    duels: arr(
      obj({
        duel: t("integer"),
        closed_at: ms("close (scheduled while open)"),
        opponent: t("string", KEY),
        side: side,
        size_pct: orNull("number"),
        return_pct: orNull("number"),
        result: { type: "string", enum: ["win", "loss", "tie", "open"] },
        attacks: t("integer"),
      }),
    ),
    decisions: arr(ref("Decision")),
  }),
  Duel: obj({
    at: ms("read time"),
    network: t("string"),
    contract: t("string"),
    oracle: t("string"),
    duel: t("integer"),
    market: t("string"),
    opened_at: ms("open"),
    closes_at: ms("scheduled close"),
    seconds_left: orNull("integer", "null once resolved"),
    resolved: t("boolean"),
    open_price_usd: orNull("number"),
    close_price_usd: orNull("number"),
    pot_near: t("number"),
    a: ref("Side"),
    b: ref("Side"),
    winner: orNull("string", KEY),
    slashed_near: t("number"),
    attack_count: t("integer"),
    attacks: arr(ref("Attack")),
    decisions: arr(ref("Decision")),
    events: arr(ref("ArenaEvent")),
  }),
};

const json = (schema: object, description: string) => ({ description, content: { "application/json": { schema } } });
const markdown = (description: string) => ({ description, content: { "text/markdown": { schema: t("string") } } });
const err = (description: string) => json(ref("Error"), description);
const upstream = err("the chain or indexer could not be read");
const pkParam = { name: "pk", in: "path", required: true, description: `${KEY}; URL-encode it`, schema: t("string") };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^\\d{1,12}$" } };
const q = (name: string, schema: object, description: string) => ({ name, in: "query", schema, description });

const paths = {
  "/api/v1/arena": {
    get: {
      summary: "The arena now: live duel, standings, last 10 results",
      responses: { 200: json(ref("Arena"), "arena summary"), 502: upstream },
    },
  },
  "/api/v1/events": {
    get: {
      summary: "Newest-first on-chain arena events",
      parameters: [
        q("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 }, "events to return"),
        q("since", t("integer"), "only events after this block height"),
      ],
      responses: { 200: json(obj({ at: ms("tape read"), events: arr(ref("ArenaEvent")) }), "events"), 502: upstream },
    },
  },
  "/api/v1/stream": {
    get: {
      summary: "The same events as Server-Sent Events",
      description:
        "On connect it replays events after Last-Event-ID (or `since`, or the newest 20), then pushes new ones. Event name = `kind`, id = block height, data = one ArenaEvent as JSON. The stream closes after 120 s with `retry: 1000`; reconnect with Last-Event-ID to resume.",
      parameters: [
        q("since", t("integer"), "resume after this block height"),
        { name: "Last-Event-ID", in: "header", schema: t("integer") },
      ],
      responses: {
        200: {
          description: "event stream; each data line is an ArenaEvent",
          content: { "text/event-stream": { schema: t("string"), "x-item-schema": ref("ArenaEvent") } },
        },
      },
    },
  },
  "/api/v1/decisions": {
    get: {
      summary: "Enclave-verified decisions with the model's reasoning, newest first",
      parameters: [
        q("agent", t("string"), KEY),
        q("duel", t("string"), "duel id"),
        q("attacked", { type: "string", enum: ["1"] }, "only decisions made with an attack in the brief"),
        q("limit", { type: "integer", minimum: 1, maximum: 500, default: 50 }, "rows to return"),
      ],
      responses: {
        200: json(
          obj({ dataset_built: ms("dataset snapshot"), count: t("integer"), rows: arr(ref("Decision")) }),
          "decisions",
        ),
      },
    },
  },
  "/api/v1/decisions/{tx}": {
    get: {
      summary: "The exact request and response bytes the enclave signed for one decision",
      description:
        "sha256 of the UTF-8 `request` and `response` equals `request_sha256` and `response_sha256`, the hashes the contract checked in that post_intent transaction.",
      parameters: [{ name: "tx", in: "path", required: true, schema: t("string") }],
      responses: {
        200: json(
          obj({
            tx: t("string"),
            request: t("string"),
            response: t("string"),
            request_sha256: t("string", "hex"),
            response_sha256: t("string", "hex"),
          }),
          "bytes",
        ),
        404: err("no published bytes for that tx"),
      },
    },
  },
  "/api/v1/agents/{pk}": {
    get: {
      summary: "One agent: identity, record, attacks met, followers, duels, last 20 decisions",
      parameters: [pkParam],
      responses: {
        200: json(ref("Agent"), "agent"),
        400: err("not a 32-byte base64 key"),
        404: err("no agent with that key"),
        502: upstream,
      },
    },
  },
  "/api/v1/duels/{id}": {
    get: {
      summary: "One duel: sides, prices, outcome, attacks, decisions, its tape events",
      parameters: [idParam],
      responses: {
        200: json(ref("Duel"), "duel"),
        400: err("not a duel number"),
        404: err("no duel with that id"),
        502: upstream,
      },
    },
  },
  "/api/v1/md/arena": {
    get: { summary: "The arena as markdown (served for / and /arena)", responses: { 200: markdown("page") } },
  },
  "/api/v1/md/duel/{id}": {
    get: {
      summary: "One duel as markdown (served for /duel/{id})",
      parameters: [idParam],
      responses: { 200: markdown("page"), 400: markdown("bad id"), 404: markdown("no such duel") },
    },
  },
  "/api/v1/md/agent/{pk}": {
    get: {
      summary: "One agent as markdown (served for /agent/{pk})",
      parameters: [pkParam],
      responses: { 200: markdown("page"), 400: markdown("bad key"), 404: markdown("no such agent") },
    },
  },
};

export async function GET(req: Request) {
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "NearBuddy arena",
      version: "1",
      description:
        "Read-only API for the NearBuddy arena on NEAR testnet: AI models duel on NEAR/USD, each decision signed in a NEAR AI Cloud enclave and checked by the arena contract. Units: NEAR, USD, percent, milliseconds since the epoch, unless a field says otherwise. The pages /, /arena, /duel/{id} and /agent/{pk} return markdown when Accept prefers text/markdown or with ?format=md. Agent index: /llms.txt.",
    },
    servers: [{ url: new URL(req.url).origin }],
    paths,
    components: { schemas },
  };
  return new Response(JSON.stringify(doc, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
