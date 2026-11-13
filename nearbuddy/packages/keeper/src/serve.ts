// The operator's HTTP surface (operator-cli.ts serves it on 127.0.0.1): GET /status for anyone who can reach it, and
// POST /match {a, b} for whoever holds the shared secret. No side effects on import.
import { timingSafeEqual } from "node:crypto";
import type { AgentView } from "../../protocol/src/abi/arena.ts";
import type { Status } from "./operator.ts";

/** What the surface needs of an Operator. */
export interface Ops {
  status(): Status;
  agents(): Promise<AgentView[]>;
  start(a: string, b: string): Promise<Status>;
}
export type Req = { method: string; path: string; secret: string | undefined; body: string };
export type Res = { status: number; body: unknown };

const same = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The last model list read per operator: a status poll must not fail because one chain read was throttled. */
const lastModels = new WeakMap<Ops, { id: string; idle: boolean }[]>();

/** Each model some keyless agent runs, with whether one of its agents is idle now; the last list read when the chain
 *  cannot be read. */
async function models(op: Ops): Promise<{ id: string; idle: boolean }[]> {
  try {
    const by = new Map<string, boolean>();
    for (const a of await op.agents()) by.set(a.model_id, (by.get(a.model_id) ?? false) || a.in_duel === null);
    const list = [...by].map(([id, idle]) => ({ id, idle })).sort((x, y) => x.id.localeCompare(y.id));
    lastModels.set(op, list);
    return list;
  } catch (e) {
    const last = lastModels.get(op);
    if (last) return last;
    throw e;
  }
}

export async function handle(op: Ops, secret: string, req: Req): Promise<Res> {
  if (req.method === "GET" && req.path === "/status")
    return { status: 200, body: { ...op.status(), models: await models(op) } };
  if (req.method !== "POST" || req.path !== "/match") return { status: 404, body: { error: "not found" } };
  if (!req.secret || !same(req.secret, secret)) return { status: 401, body: { error: "bad secret" } };
  let a: unknown;
  let b: unknown;
  try {
    ({ a, b } = JSON.parse(req.body) as { a?: unknown; b?: unknown });
  } catch {}
  if (typeof a !== "string" || typeof b !== "string")
    return { status: 400, body: { error: "body must be {a, b}: two model ids" } };
  const known = new Set((await models(op)).map((m) => m.id));
  if (!known.has(a) || !known.has(b)) return { status: 400, body: { error: "no agent runs that model" } };
  try {
    return { status: 200, body: await op.start(a, b) };
  } catch (e) {
    // busy, or no idle agent for a model: the caller may retry later
    return { status: 409, body: { error: String(e instanceof Error ? e.message : e).slice(0, 200) } };
  }
}
