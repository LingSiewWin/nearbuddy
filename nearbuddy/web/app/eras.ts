// Scoring eras: duels before ORACLE_ERA_FROM were scored by the operator key, the rest by the Outlayer TEE
// oracle. The contract keeps one lifetime alpha per agent, so the oracle-era figures are summed here from
// the duels themselves and the operator-era alpha is the remainder. Read side only.

/** First duel scored by the Outlayer TEE oracle for a NEAR_NETWORK: the testnet arena's duels 0-256 were scored
 *  by the operator key; a mainnet arena is oracle-scored from duel 0. */
export const oracleEraFrom = (network: string | undefined) => (network === "mainnet" ? 0 : 257);
/** This deploy's boundary. Server side only: the browser bundle has no NEAR_NETWORK, so pages take `eras.from`. */
export const ORACLE_ERA_FROM = oracleEraFrom(process.env.NEAR_NETWORK);
/** The boundary a page assumes before the API answers. Next inlines NEXT_PUBLIC_ vars into the bundle at build. */
export const pageEraFrom = () => oracleEraFrom(process.env.NEXT_PUBLIC_NEAR_NETWORK);

export const isOracleEra = (id: string | number) => Number(id) >= ORACLE_ERA_FROM;

/** Ids of every oracle-era duel that exists, newest first. */
export const oracleIds = (nextDuel: number) =>
  Array.from({ length: Math.max(0, nextDuel - ORACLE_ERA_FROM) }, (_, i) => String(nextDuel - 1 - i));

/** Ids of every operator-era duel that exists, newest first. */
export const operatorIds = (nextDuel: number) =>
  Array.from({ length: Math.min(nextDuel, ORACLE_ERA_FROM) }, (_, i) =>
    String(Math.min(nextDuel, ORACLE_ERA_FROM) - 1 - i),
  );

export type ScoredDuel = {
  id: string;
  a: string;
  b: string;
  resolved: boolean;
  outcome?: {
    pnl_a: number;
    pnl_b: number;
    winner: string | null;
    open_price?: string | number;
    close_price?: string | number;
  } | null;
  no_reveal?: [boolean, boolean] | null; // get_no_reveal, deploy 14 on
};
/** Oracle-era duels a split cannot trust yet: a failed read (null), or a resolved duel whose `no_reveal` read
 *  failed when the contract has commit-reveal. Any of these would shift alpha into the operator remainder. */
export const unread = (duels: (ScoredDuel | null)[], noReveal: boolean) =>
  duels.filter((d) => !d || (noReveal && d.resolved && d.no_reveal === undefined)).length;

/** `void_duel` writes an outcome with both prices 0 (no oracle price ever arrived); it was never played. */
export const isVoid = (o: { open_price?: string | number; close_price?: string | number } | null | undefined) =>
  !!o && Number(o.open_price) === 0 && Number(o.close_price) === 0;

/** `duels` = scored duels (wins + ties + losses); voided duels are counted apart and add nothing. */
export type Tally = { alpha_bps: number; wins: number; ties: number; losses: number; voids: number; duels: number };

/** One agent's alpha and record over resolved duels, credited as `finish` does: a side that left a
 *  commitment unrevealed takes no gain, only its loss. A voided duel is not a tie. */
export function tally(pk: string, duels: ScoredDuel[]): Tally {
  const t: Tally = { alpha_bps: 0, wins: 0, ties: 0, losses: 0, voids: 0, duels: 0 };
  for (const d of duels) {
    if (!d.resolved || !d.outcome || (d.a !== pk && d.b !== pk)) continue;
    if (isVoid(d.outcome)) {
      t.voids += 1; // void_duel leaves alpha alone
      continue;
    }
    const side = d.a === pk ? 0 : 1;
    const pnl = side === 0 ? d.outcome.pnl_a : d.outcome.pnl_b;
    t.alpha_bps += d.no_reveal?.[side] ? Math.min(pnl, 0) : pnl;
    t.duels += 1;
    if (d.outcome.winner === null) t.ties += 1;
    else if (d.outcome.winner === pk) t.wins += 1;
    else t.losses += 1;
  }
  return t;
}

/** Per agent: the oracle-era tally and the operator-era alpha (lifetime alpha minus the oracle-era sum).
 *  `oracleDuels` must hold every oracle-era duel, or the remainder absorbs what is missing. */
export function eraSplit(agents: { pk: string; alpha_bps: number }[], oracleDuels: ScoredDuel[]) {
  return Object.fromEntries(
    agents.map((a) => {
      const oracle = tally(a.pk, oracleDuels);
      return [a.pk, { oracle, operator_alpha_bps: a.alpha_bps - oracle.alpha_bps }];
    }),
  );
}
export type EraSplit = ReturnType<typeof eraSplit>;
