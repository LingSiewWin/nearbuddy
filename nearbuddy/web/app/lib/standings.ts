// LiveArenaBody standings from resolved matches: each model's (and each agent's) mean profit per match in bps with its sample
// standard error, and which ranks cannot be told apart. No Node API: the route and the page share it.

/** One resolved match as the standings read it: pks in base64, P&L in bps, `winner` a pk or null on a tie. */
export type Scored = { duel: string; a: string; b: string; pnl_a: number; pnl_b: number; winner: string | null };
export type AgentInfo = { pk: string; owner: string; model_id: string };
export type Row = {
  key: string;
  label: string;
  n: number;
  mean: number;
  /** Sample standard error of the mean; null with fewer than two matches. */
  se: number | null;
  w: number;
  t: number;
  l: number;
  /** Fewer matches than the board's minimum: listed after the ranked rows, never ranked. */
  thin: boolean;
  /** Rank group from 1; rows in one group are within error of the group's first row. 0 for thin rows. */
  group: number;
};

export const MIN_MODEL_GAMES = 30;
export const MIN_COACH_GAMES = 10;

/** Whether two means are closer than the 95% band of their difference, taking the two as independent. */
export function within(a: Row, b: Row): boolean {
  if (a.se === null || b.se === null) return false;
  return Math.abs(a.mean - b.mean) < 1.96 * Math.sqrt(a.se ** 2 + b.se ** 2);
}

type Tally = { label: string; pnl: number[]; w: number; t: number; l: number };

function rows(
  duels: Scored[],
  agents: Map<string, AgentInfo>,
  keyOf: (a: AgentInfo) => { key: string; label: string },
  min: number,
): Row[] {
  const by = new Map<string, Tally>();
  for (const d of duels) {
    // two agents under one key (one model playing itself) is no game for that key: it would count twice, win and
    // lose against itself, and shrink the error as if its two sides were independent
    const [ka, kb] = [agents.get(d.a), agents.get(d.b)].map((x) => (x ? keyOf(x).key : null));
    if (ka !== null && ka === kb) continue;
    for (const [pk, pnl] of [
      [d.a, d.pnl_a],
      [d.b, d.pnl_b],
    ] as const) {
      const agent = agents.get(pk);
      if (!agent) continue;
      const { key, label } = keyOf(agent);
      const t = by.get(key) ?? { label, pnl: [], w: 0, t: 0, l: 0 };
      t.pnl.push(pnl);
      if (d.winner === null) t.t++;
      else if (d.winner === pk) t.w++;
      else t.l++;
      by.set(key, t);
    }
  }
  const out = [...by].map(([key, t]): Row => {
    const n = t.pnl.length;
    const mean = t.pnl.reduce((s, x) => s + x, 0) / n;
    const se = n < 2 ? null : Math.sqrt(t.pnl.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) / n);
    return { key, label: t.label, n, mean, se, w: t.w, t: t.t, l: t.l, thin: n < min, group: 0 };
  });
  out.sort((x, y) => Number(x.thin) - Number(y.thin) || y.mean - x.mean || x.label.localeCompare(y.label));
  let group = 0;
  let leader: Row | null = null;
  for (const r of out) {
    if (r.thin) continue;
    if (!leader || !within(leader, r)) {
      group++;
      leader = r;
    }
    r.group = group;
  }
  return out;
}

/** One row per model id, labelled with the id's last path segment. */
export const modelRows = (duels: Scored[], agents: Map<string, AgentInfo>): Row[] =>
  rows(duels, agents, (a) => ({ key: a.model_id, label: a.model_id.split("/").pop() ?? a.model_id }), MIN_MODEL_GAMES);

/** One row per agent, labelled with its owner's account. */
export const coachRows = (duels: Scored[], agents: Map<string, AgentInfo>): Row[] =>
  rows(duels, agents, (a) => ({ key: a.pk, label: a.owner }), MIN_COACH_GAMES);
