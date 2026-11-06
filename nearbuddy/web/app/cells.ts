// Pure data-to-cells helpers for the commit-reveal and execution rows: no React state, no fetch, so
// bun test checks them directly (app/__tests__). Every field is optional: a deploy-13 contract (no
// commit-reveal) and a solver without quality data render as "off" or "none", never as an error.
import type { Cell } from "./tui";

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
