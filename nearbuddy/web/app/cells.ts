// Pure data-to-cells helpers for the commit-reveal and execution rows: no React state, no fetch, so
// bun test checks them directly (app/__tests__). Every field is optional: a deploy-13 contract (no
// commit-reveal) and a solver without quality data render as "off" or "none", never as an error.
import { addrHref, type Cell, near, price8 } from "./tui";

/** The commit-reveal fields of `get_config`; absent on contracts that predate commit-reveal. */
export type CommitConfig = { commit_reveal?: boolean; no_reveal_bps?: number; require_consent?: boolean };

/** One word for the arena stats strip; a contract without the field has no commit-reveal. */
export const commitWord = (c: CommitConfig | null | undefined) => (c?.commit_reveal ? "on" : "off");

/** Duel box 1, `commit-reveal` row. */
export const commitCells = (c: CommitConfig | null | undefined): Cell[] =>
  c?.commit_reveal == null
    ? [
        { t: "off", c: "dim" },
        { t: "   this contract predates commit-reveal", c: "dim" },
      ]
    : c.commit_reveal
      ? [
          { t: "on", c: "ok" },
          "   calls hidden until reveal",
          c.no_reveal_bps != null ? { t: ` · no reveal costs ${c.no_reveal_bps / 100} % of bond`, c: "dim" } : "",
        ]
      : [
          { t: "off", c: "dim" },
          { t: "   intents are posted in the clear", c: "dim" },
        ];

/** Duel box 1, per-side marker from `get_no_reveal(duel_id)` ([a, b]; null before commit-reveal). */
export const revealCell = (slashed: boolean | undefined, revealed: boolean, resolved: boolean): Cell =>
  slashed
    ? { t: "no-reveal slashed", c: "loss", title: "committed a call, never revealed it: bond slashed (get_no_reveal)" }
    : revealed
      ? { t: "revealed", c: "ok" }
      : resolved
        ? { t: "no intent", c: "dim" }
        : { t: "hidden until reveal", c: "dim" };

/** An intent counts as enclave-verified only with a non-zero proof hash; a missing hash is not a proof. */
export const proven = (i: { proof_hash?: string | null } | null | undefined, zero: string) =>
  !!i?.proof_hash && i.proof_hash !== zero;

/** One follower fill priced against the TEE oracle: solver `quality` in GET /arena, and GET /execution. */
export type Fill = {
  follower: string;
  intent_nonce: string;
  amount_in: string; // yocto wNEAR
  quote_out: string; // USDC base units, 6 decimals
  oracle_mid: string; // USD price x 1e8, as the oracle reports it
  quoted_at: number; // ms since epoch
  bps_vs_oracle: number | null; // quote vs oracle mid; positive = the follower got more than mid; null in old rows
};

export const usdc = (base: string | null | undefined) => (base ? (Number(base) / 1e6).toFixed(4) : "-");
/** A usable bps figure: old persisted rows may carry null (or junk) instead of a number. */
const priced = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
/** Signed bps with one decimal: "+3.2", "-0.5", "0.0"; "-" when unpriced. */
export const sbps = (n: number | null | undefined) => (priced(n) ? `${n > 0 ? "+" : ""}${n.toFixed(1)}` : "-");
/** Price vs oracle mid, coloured: better for the follower is a win, worse a loss; unpriced is a dim "-". */
export const vsCell = (n: number | null | undefined, width = 0): Cell =>
  priced(n)
    ? {
        t: `${sbps(n)} bps`.padStart(width),
        c: n > 0 ? "win" : n < 0 ? "loss" : "tie",
        title: n > 0 ? "better than the oracle mid" : n < 0 ? "worse than the oracle mid" : "at the oracle mid",
      }
    : { t: "-".padStart(width), c: "dim", title: "not priced against the oracle mid" };
/** Compact age: 42s, 7m, 3h, 2d. */
export const age = (ms: number, nowMs: number) => {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
};

/** The newest `n` fills, newest first; the solver appends, so the tail is newest. */
export const lastFills = (q: Fill[] | null | undefined, n = 10) => (q ?? []).slice(-n).reverse();

// columns: follower · amount in · quoted out · oracle mid · vs mid · age
export const FILL_HEAD = `${"follower".padEnd(21)}  ${"amount in".padStart(14)}   ${"quoted out".padStart(15)}  ${"mid USD".padStart(7)}  ${"vs mid".padStart(10)}  ${"age".padStart(8)}`;
export const fillCells = (f: Fill, nowMs: number): Cell[] => [
  { t: f.follower.slice(0, 21), href: addrHref(f.follower), title: f.follower },
  " ".repeat(Math.max(0, 21 - f.follower.length)),
  `  ${near(f.amount_in).padStart(8)} wNEAR → ${usdc(f.quote_out).padStart(10)} USDC  ${price8(f.oracle_mid).padStart(7)}  `,
  vsCell(f.bps_vs_oracle, 10),
  `  ${age(f.quoted_at, nowMs).padStart(4)} ago`,
];

/** Per-follower execution summary for the given followers, in their order; followers without fills are left out.
 *  `n` counts every fill; avg/best/worst cover the priced ones and are null when none is priced. */
export const followerQuality = (q: Fill[] | null | undefined, followers: string[]) =>
  followers.flatMap((follower) => {
    const mine = (q ?? []).filter((f) => f.follower === follower);
    if (!mine.length) return [];
    const b = mine.map((f) => f.bps_vs_oracle).filter(priced);
    return [
      {
        follower,
        n: mine.length,
        avg: b.length ? b.reduce((x, y) => x + y, 0) / b.length : null,
        best: b.length ? Math.max(...b) : null,
        worst: b.length ? Math.min(...b) : null,
        last: Math.max(...mine.map((f) => f.quoted_at)),
      },
    ];
  });
