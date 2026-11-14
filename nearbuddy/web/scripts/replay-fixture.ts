// The home page's replay, as a committed fixture: `bun scripts/replay-fixture.ts [duel id]` reads one finished duel
// from the chain (the arena's views, its transactions over the duel's window, and the same checks as
// `bun run verify-duel`) plus the exchange's one-minute candles for that window, and rewrites app/data/replay.json.
// Nothing in the file is typed by hand: re-run it to change the duel the replay plays.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eventsOf, type Tx } from "../app/api/events/chain";
import { ARENA } from "../app/api/near";
import { samplesOf } from "../app/lib/replay";
import { checkDuel, collect, state } from "../app/lib/verify";

const OUT = fileURLToPath(new URL("../app/data/replay.json", import.meta.url));
const id = process.argv[2] ?? "575";
const ms = (ns: string) => Math.floor(Number(BigInt(ns) / 1_000_000n));

const now = await state(ARENA, id);
const d = now.duel;
if (!d?.resolved || !d.open_at || !d.outcome) throw new Error(`duel ${id} is not a finished duel on ${ARENA}`);
const evidence = await collect(ARENA, id, now);
const lines = checkDuel(evidence);
const events = evidence.txs
  .flatMap((t) => eventsOf(t as unknown as Tx, ARENA))
  .filter((e) => e.duel_id === id)
  .sort((x, y) => x.at_ms - y.at_ms)
  .map(({ event, agent_pk, at_ms, side, tx }) => ({ event, agent_pk, at_ms, side: side ?? null, tx }));
const [from, to] = [ms(d.open_at), ms(d.close_at)];
// display only, like the live price line: a duel settles on the oracle's prices, which are in `outcome`
const start = new Date(Math.floor(from / 60_000) * 60_000).toISOString();
const end = new Date(Math.ceil(to / 60_000) * 60_000).toISOString();
const candles = await fetch(
  `https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=60&start=${start}&end=${end}`,
  { headers: { "user-agent": "replay-fixture" } },
)
  .then((r) => r.json())
  .catch(() => null);
const agent = (v: typeof now.a, before: typeof now.a) =>
  v && { pk: v.pk, model: v.model_id, tee: v.tee, bond_before: before?.bond ?? null };
const body = {
  source: `${ARENA} get_duel, get_chaos, FastNEAR tx history; checks of bun run verify-duel ${id}`,
  built: new Date().toISOString(),
  arena: ARENA,
  id,
  from,
  to,
  a: agent(now.a, evidence.before?.a ?? null),
  b: agent(now.b, evidence.before?.b ?? null),
  outcome: d.outcome,
  chaos: evidence.chaos ?? [],
  events,
  price: { source: "Coinbase Exchange NEAR-USD one-minute candles", samples: samplesOf(candles, from - 60_000, to + 60_000) },
  checks: lines.map((l) => ({ result: l.result, check: l.check })),
};
writeFileSync(OUT, `${JSON.stringify(body, null, 1)}\n`);
console.log(`replay: duel ${id}, ${events.length} events, ${body.chaos.length} headlines, ${body.price.samples.length} price samples, ${lines.filter((l) => l.result === "PASS").length} of ${lines.length} checks pass -> ${OUT}`);
