// Pure data-to-cells helpers for the commit-reveal and execution rows: no React state, no fetch, so
// bun test checks them directly (app/__tests__). Every field is optional: a deploy-13 contract (no
// commit-reveal) and a solver without quality data render as "off" or "none", never as an error.
import { addrHref, type Cell, near, price8, short, txHref } from "./tui";

/** The commit-reveal fields of `get_config`; absent on contracts that predate commit-reveal. */
export type CommitConfig = { commit_reveal?: boolean; no_reveal_bps?: number; require_consent?: boolean };

/** One word for the arena stats strip; a contract without the field has no commit-reveal. */
export const commitWord = (c: CommitConfig | null | undefined) => (c?.commit_reveal ? "on" : "off");

/** Arena stats strip: how duels get paired now; null on contracts without the field. */
export const pairingWord = (c: CommitConfig | null | undefined) =>
  c?.require_consent == null ? null : c.require_consent ? "consent required" : "open";

/** The tx that opened a duel, as GET /api/events finds it in FastNEAR's tx window. */
export type Opened = { duel_id: string; method: string; tx: string; at_ms: number };

/** Duel box 1, `pairing` row: from the open tx's method when it is in the scanned window, else from today's
 *  `require_consent` (labelled as such: the flag may have changed since the duel opened). */
export const pairingCells = (opened: Opened | null | undefined, c: CommitConfig | null | undefined): Cell[] => {
  const tx = (o: Opened): Cell[] => [
    { t: `   ${o.method} tx `, c: "dim" },
    { t: short(o.tx, 10), href: txHref(o.tx), title: o.tx },
  ];
  if (opened?.method === "open_duel_consented")
    return [
      { t: "both agents signed this duel", c: "ok", title: "each agent key signed consent_message for this pairing" },
      ...tx(opened),
    ];
  if (opened?.method === "open_duel")
    return [{ t: "opened by the owner, no agent signatures", c: "dim" }, ...tx(opened)];
  if (c?.require_consent == null) return [{ t: "this contract predates consented pairing", c: "dim" }];
  const why = { t: "   from get_config now; the open tx is not in the scanned window", c: "dim" };
  return c.require_consent
    ? [{ t: "consent required", c: "ok", title: "open_duel is refused; only open_duel_consented pairs agents" }, why]
    : [{ t: "open", c: "dim", title: "the owner may pair agents without their signatures" }, why];
};

/** The contract's rule for a commitment left unrevealed at scoring (deploy 14). */
export const NO_REVEAL_RULE =
  "an unrevealed side forfeits the duel and pays no_reveal_bps of its bond to the opponent; both unrevealed is a tie and both slashes go to the protocol";

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
          c.no_reveal_bps != null
            ? {
                t: ` · no reveal = forfeit + ${c.no_reveal_bps / 100} % of bond to the opponent`,
                c: "dim",
                title: NO_REVEAL_RULE,
              }
            : "",
        ]
      : [
          { t: "off", c: "dim" },
          { t: "   intents are posted in the clear", c: "dim" },
        ];

/** Duel box 1, per-side marker from `get_no_reveal(duel_id)` ([a, b]; null before commit-reveal). */
export const revealCell = (
  nr: readonly [boolean, boolean] | null | undefined,
  side: 0 | 1,
  revealed: boolean,
  resolved: boolean,
): Cell =>
  nr?.[side]
    ? nr[1 - side]
      ? {
          t: "no reveal: tie",
          c: "loss",
          title: "neither side revealed: a tie, both no-reveal slashes go to the protocol (get_no_reveal)",
        }
      : {
          t: "no reveal: forfeit",
          c: "loss",
          title:
            "committed a call, never revealed it: forfeits the duel, pays no_reveal_bps of its bond to the opponent",
        }
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
  side?: "Long" | "Short"; // the agent's side; absent in rows from solvers that only sold (read as Short)
  amount_in: string; // yocto wNEAR: sold on a Short, bought on a Long
  quote_out: string; // USDC base units, 6 decimals: received on a Short, paid on a Long
  oracle_mid: string; // USD price x 1e8, as the oracle reports it
  quoted_at: number; // ms since epoch
  bps_vs_oracle: number | null; // vs oracle mid, positive = better for the follower on either side; null in old rows
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

/** Direction of a fill or quote: a Short sells wNEAR for USDC (→), a Long buys wNEAR with USDC (←).
 *  No side means a solver from before fills followed the agent's side, which only sold. */
export const legs = (side: "Long" | "Short" | null | undefined) =>
  side === "Long"
    ? { word: "buy", arrow: "←", title: "Long: bought wNEAR, paid USDC" }
    : { word: "sell", arrow: "→", title: "Short: sold wNEAR, received USDC" };

// columns: follower · side · wNEAR leg · USDC leg · oracle mid · vs mid · age
export const FILL_HEAD = `${"follower".padEnd(21)}  ${"side"} ${"wNEAR leg".padStart(14)}   ${"USDC leg".padStart(15)}  ${"mid USD".padStart(7)}  ${"vs mid".padStart(10)}  ${"age".padStart(8)}`;
export const fillCells = (f: Fill, nowMs: number): Cell[] => {
  const l = legs(f.side);
  return [
    { t: f.follower.slice(0, 21), href: addrHref(f.follower), title: f.follower },
    " ".repeat(Math.max(0, 21 - f.follower.length)),
    "  ",
    { t: l.word.padEnd(4), title: l.title },
    ` ${near(f.amount_in).padStart(8)} wNEAR ${l.arrow} ${usdc(f.quote_out).padStart(10)} USDC  ${price8(f.oracle_mid).padStart(7)}  `,
    vsCell(f.bps_vs_oracle, 10),
    `  ${age(f.quoted_at, nowMs).padStart(4)} ago`,
  ];
};

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

/** A solver intent's per-follower quote. With batched RFQ `quote` is the whole batch and `quote_out` is
 *  this follower's pro-rata share (6-dp base units); older solvers send only `quote`. */
export type FollowerQuote = {
  follower: string;
  amount: string;
  quote_out?: string;
  price?: string | number;
  quote?: { quote: { amountOutFormatted: string } };
};
/** USDC out for one follower: its batch share when present, else the 1Click quote, else "?". */
export const quoteOut = (q: FollowerQuote) =>
  q.quote_out ? usdc(q.quote_out) : (q.quote?.quote.amountOutFormatted ?? "?");
