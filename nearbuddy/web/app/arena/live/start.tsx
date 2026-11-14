// The "start match" panel: pick two models, and the operator service opens a real match between an idle agent of
// each. Shown only where an operator runs (GET /api/arena/live/start says so). One match at a time: while the operator is
// busy, or a match is live, the button is off and the panel says where the match is.
import { useEffect, useState } from "react";

type Model = { id: string; idle: boolean };
export type Operator = {
  available: boolean;
  busy?: boolean;
  phase?: string;
  duel?: string | null;
  close_at?: number | null;
  error?: string | null;
  models?: Model[];
};

const short = (id: string) => id.split("/").pop() ?? id;
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Where the operator's match is, in words. */
function where(op: Operator, now: number): string {
  switch (op.phase) {
    case "opening":
      return "opening the match";
    case "calling":
      return `match #${op.duel}: open; the models are calling`;
    case "racing":
      return op.close_at ? `match #${op.duel}: both models have called; closes in ${clock(op.close_at - now)}` : "";
    case "resolving":
      return `match #${op.duel}: closed; waiting for the oracle's closing price, which can take a few minutes`;
    case "failed":
      return `the last start failed: ${op.error ?? "unknown"}`;
    default:
      return "";
  }
}

export function Start({
  op,
  now,
  live,
  onStarted,
}: {
  op: Operator;
  now: number;
  /** A match is on stage already. */
  live: boolean;
  onStarted: (op: Operator) => void;
}) {
  const models = op.models ?? [];
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // default to the first two models once the list arrives
  useEffect(() => {
    if (!a && models[0]) setA(models[0].id);
    if (!b && models[0]) setB((models[1] ?? models[0]).id);
  }, [models, a, b]);
  if (!op.available) return null;

  async function start() {
    setSending(true);
    setRefused(null);
    try {
      const r = await fetch("/api/arena/live/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a, b }),
      });
      const j = (await r.json()) as Operator & { error?: string };
      if (r.ok) onStarted(j);
      else setRefused(j.error ?? `HTTP ${r.status}`);
    } catch {
      setRefused("the site did not answer");
    } finally {
      setSending(false);
    }
  }

  const pickOne = (value: string, set: (v: string) => void, label: string) => (
    <select value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.idle ? short(m.id) : `${short(m.id)} (playing)`}
        </option>
      ))}
    </select>
  );
  const off = sending || !!op.busy || live || !a || !b;
  return (
    <section id="start" className="panel start" aria-labelledby="start-h">
      <h2 id="start-h">
        START A MATCH <span>a real match on NEAR testnet: about 6 minutes, then a few more for the oracle</span>
      </h2>
      <div className="pickers">
        {pickOne(a, setA, "First model")}
        <span className="dim">vs</span>
        {pickOne(b, setB, "Second model")}
        <button type="button" onClick={start} disabled={off}>
          start match
        </button>
      </div>
      {where(op, now) ? <p>{where(op, now)}</p> : null}
      {refused ? <p className="warn">{refused}</p> : null}
      {a && a === b ? <p className="dim">one model against itself does not count on the model board</p> : null}
    </section>
  );
}
