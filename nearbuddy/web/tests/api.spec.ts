// The agent-facing API against a running app: every v1 response must match the schema /openapi.json serves
// (no undeclared field, no missing required one), the published bytes must re-hash to their sha256 fields,
// pages must negotiate markdown, and every v1 route file must be listed in /openapi.json and /llms.txt.
// Reads the chain over the public RPC like smoke.spec.ts, so a run needs the network.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

type Schema = Record<string, any>;
let doc: { openapi: string; paths: Record<string, any>; components: { schemas: Record<string, Schema> } };

const kind = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

/** A small JSON Schema check: $ref, oneOf, const, enum, type, required and no undeclared properties. */
function check(s: Schema, v: unknown, at = "$"): string[] {
  if (s.$ref) return check(doc.components.schemas[String(s.$ref).split("/").pop() as string] as Schema, v, at);
  if (s.oneOf) {
    const fits = (s.oneOf as Schema[]).map((x) => check(x, v, at));
    return fits.some((e) => !e.length) ? [] : [`${at}: matches no oneOf branch: ${fits.map((e) => e[0]).join("; ")}`];
  }
  if ("const" in s && v !== s.const) return [`${at}: ${String(v)} is not ${s.const}`];
  if (s.enum && !s.enum.includes(v)) return [`${at}: ${String(v)} is not in the enum`];
  const types = [s.type].flat().filter(Boolean);
  const k = kind(v);
  if (types.length && !types.includes(k) && !(k === "integer" && types.includes("number")))
    return [`${at}: ${k} is not ${types.join("|")}`];
  if (k === "array") return (v as unknown[]).flatMap((x, i) => check(s.items, x, `${at}[${i}]`));
  if (k !== "object" || !s.properties) return [];
  const o = v as Record<string, unknown>;
  return [
    ...Object.keys(o)
      .filter((x) => !(x in s.properties))
      .map((x) => `${at}.${x}: not in the schema`),
    ...((s.required ?? []) as string[]).filter((x) => !(x in o)).map((x) => `${at}.${x}: missing`),
    ...Object.entries(o).flatMap(([x, y]) => (s.properties[x] ? check(s.properties[x], y, `${at}.${x}`) : [])),
  ];
}
const schemaOf = (path: string, status = 200) =>
  doc.paths[path].get.responses[status].content["application/json"].schema as Schema;

/** GET a v1 path, expect the status, and check the body against that path's schema for the status. */
async function getChecked(request: APIRequestContext, url: string, path: string, status = 200) {
  const r = await request.get(url);
  expect(r.status(), `${url}: ${(await r.text()).slice(0, 200)}`).toBe(status);
  expect(r.headers()["content-type"]).toContain("application/json");
  const body = await r.json();
  expect(check(schemaOf(path, status), body), url).toEqual([]);
  return body;
}

/** Every route file under app/api/v1 as an OpenAPI path: [pk] becomes {pk}. */
const v1Paths = () =>
  (readdirSync(join(__dirname, "../app/api/v1"), { recursive: true }) as string[])
    .filter((f) => f.endsWith("route.ts"))
    .map((f) => `/api/v1/${f.replace(/\\/g, "/").replace(/\/?route\.ts$/, "")}`.replace(/\[(\w+)\]/g, "{$1}"))
    .map((p) => p.replace(/\/$/, ""));

let arena: {
  live: { duel: number } | null;
  standings: { agent: string }[];
  recent: { duel: number }[];
};

test.beforeAll(async ({ request }) => {
  const r = await request.get("/openapi.json");
  expect(r.status()).toBe(200);
  doc = await r.json();
});

test("/api/v1/arena matches its schema", async ({ request }) => {
  arena = await getChecked(request, "/api/v1/arena", "/api/v1/arena");
  expect(arena.standings.length).toBeGreaterThan(0);
});

test("/api/v1/events matches its schema and honours limit", async ({ request }) => {
  const body = await getChecked(request, "/api/v1/events?limit=5", "/api/v1/events");
  expect(body.events.length).toBeGreaterThan(0);
  expect(body.events.length).toBeLessThanOrEqual(5);
});

test("/api/v1/decisions matches its schema; the published bytes re-hash to their sha256", async ({ request }) => {
  const body = await getChecked(request, "/api/v1/decisions?attacked=1&limit=5", "/api/v1/decisions");
  expect(body.rows.length).toBeGreaterThan(0);
  for (const row of body.rows) expect(row.attack).toBeTruthy();
  const tx = body.rows.find((r: { tx: string | null }) => r.tx)?.tx as string;
  const b = await getChecked(request, `/api/v1/decisions/${tx}`, "/api/v1/decisions/{tx}");
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  expect(b.tx).toBe(tx);
  expect(sha(b.request)).toBe(b.request_sha256);
  expect(sha(b.response)).toBe(b.response_sha256);
  await getChecked(request, "/api/v1/decisions/nope", "/api/v1/decisions/{tx}", 404);
});

test("/api/v1/agents/<pk> takes an encoded key with + and /, and rejects bad keys", async ({ request }) => {
  if (!arena) arena = (await (await request.get("/api/v1/arena")).json()) as typeof arena;
  const pk = (arena.standings.find((a) => /[+/]/.test(a.agent)) ?? arena.standings[0])?.agent as string;
  const enc = encodeURIComponent(pk); // %2B %2F %3D
  const a = await getChecked(request, `/api/v1/agents/${enc}`, "/api/v1/agents/{pk}");
  expect(a.agent).toBe(pk);
  expect(a.decisions.length).toBeLessThanOrEqual(20);
  for (const d of a.decisions) expect(d.agent).toBe(pk);
  const partly = pk.replace(/\//g, "%2F"); // + and = left raw, as some clients send them
  expect((await (await request.get(`/api/v1/agents/${partly}`)).json()).agent).toBe(pk);
  for (const bad of ["nope", encodeURIComponent(`${"!".repeat(43)}=`), encodeURIComponent(pk.slice(1))])
    await getChecked(request, `/api/v1/agents/${bad}`, "/api/v1/agents/{pk}", 400);
  await getChecked(request, `/api/v1/agents/${encodeURIComponent(`${"A".repeat(43)}=`)}`, "/api/v1/agents/{pk}", 404);
});

test("/api/v1/duels/<id> matches its schema and rejects bad ids", async ({ request }) => {
  if (!arena) arena = (await (await request.get("/api/v1/arena")).json()) as typeof arena;
  const id = arena.recent[0]?.duel ?? arena.live?.duel;
  expect(id).toBeDefined();
  const d = await getChecked(request, `/api/v1/duels/${id}`, "/api/v1/duels/{id}");
  expect(d.duel).toBe(id);
  for (const x of d.decisions) expect(x.duel).toBe(String(id));
  for (const e of d.events) expect(e.duel).toBe(id);
  await getChecked(request, "/api/v1/duels/abc", "/api/v1/duels/{id}", 400);
  await getChecked(request, "/api/v1/duels/999999999", "/api/v1/duels/{id}", 404);
});

test("/arena answers markdown to text/markdown and HTML otherwise", async ({ request }) => {
  const md = await request.get("/arena", { headers: { accept: "text/markdown, text/html, */*" } });
  expect(md.status()).toBe(200);
  expect(md.headers()["content-type"]).toContain("text/markdown");
  expect(md.headers().vary).toContain("Accept");
  expect(md.headers().link).toContain('</llms.txt>; rel="describedby"');
  expect(await md.text()).toMatch(/^# NearBuddy arena\n[\s\S]*## Standings/);
  expect((await request.get("/arena?format=md")).headers()["content-type"]).toContain("text/markdown");
  for (const accept of ["text/html,application/xhtml+xml,*/*;q=0.8", "*/*", "text/markdown;q=0.5, text/html"]) {
    const html = await request.get("/arena", { headers: { accept } });
    expect(html.headers()["content-type"], accept).toContain("text/html");
    expect(html.headers().link).toContain('</llms.txt>; rel="describedby"');
  }
});

test("/openapi.json is OpenAPI 3.1 and lists every v1 route", async () => {
  expect(doc.openapi).toBe("3.1.0");
  const paths = v1Paths();
  expect(paths.length).toBeGreaterThanOrEqual(10);
  for (const p of paths) expect(Object.keys(doc.paths), p).toContain(p);
  expect(Object.keys(doc.paths["/api/v1/stream"].get.responses[200].content)).toEqual(["text/event-stream"]);
});

test("/llms.txt lists every v1 route and /openapi.json", async ({ request }) => {
  const txt = await (await request.get("/llms.txt")).text();
  for (const p of [...v1Paths(), "/openapi.json"]) expect(txt, p).toContain(p);
});
