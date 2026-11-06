// Pure data-to-cells helpers for the commit-reveal and execution rows: no React state, no fetch, so
// bun test checks them directly (app/__tests__). Every field is optional: a deploy-13 contract (no
// commit-reveal) and a solver without quality data render as "off" or "none", never as an error.
import { addrHref, agentHref, type Cell, near, price8, short, txHref } from "./tui";

/** The commit-reveal fields of `get_config`; absent on contracts that predate commit-reveal. */
export type CommitConfig = { commit_reveal?: boolean; no_reveal_bps?: number; require_consent?: boolean };

/** One word for the arena stats strip; a contract without the field has no commit-reveal. */
export const commitWord = (c: CommitConfig | null | undefined) => (c?.commit_reveal ? "on" : "off");

/** Arena stats strip: how duels get paired now; null on contracts without the field. */
export const pairingWord = (c: CommitConfig | null | undefined) =>
  c?.require_consent == null ? null : c.require_consent ? "consent required" : "open";

/** The tx that opened a duel, as GET /api/events finds it in FastNEAR's tx window. */
export type Opened = { duel_id: string; method: string; tx: string; at_ms: number };

/** A `commit` or `intent` EVENT_JSON log of the arena, with the method of the receipt that emitted it. */
export type ChainEvent = {
  event: "commit" | "intent";
  duel_id: string;
  agent_pk: string;
  method: string;
  tx: string;
  at_ms: number;
};

const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** Duel box 1, one side's commit and reveal times from chain events (any order): the last commitment and
 *  the first reveal after it; "hidden" until that reveal lands, "never revealed" once the duel resolved. */
export const timelineCells = (events: ChainEvent[] | null | undefined, pk: string, resolved: boolean): Cell[] => {
  const mine = (events ?? []).filter((e) => e.agent_pk === pk).sort((x, y) => x.at_ms - y.at_ms);
  const commits = mine.filter((e) => e.event === "commit");
  const c = commits.at(-1);
  if (!c) {
    const posted = mine.filter((e) => e.event === "intent").at(-1);
    return posted
      ? [`posted ${hms(posted.at_ms)}`, { t: "   in the clear, no commitment", c: "dim" }]
      : [{ t: "no commit seen", c: "dim" }];
  }
  const r = mine.find((e) => e.event === "intent" && e.method === "reveal_intent" && e.at_ms >= c.at_ms);
  return [
    { t: `committed ${hms(c.at_ms)}`, href: txHref(c.tx), title: c.tx },
    " · ",
    r
      ? { t: `revealed ${hms(r.at_ms)}`, c: "ok", href: txHref(r.tx), title: r.tx }
      : { t: resolved ? "never revealed" : "hidden", c: resolved ? "loss" : "dim" },
    commits.length > 1 ? { t: `   ${commits.length} commits, last shown`, c: "dim" } : "",
  ];
};

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

/** Agent pairs dueling in a window of duels, most recent first: the arena can run more than one pair at once. */
export type Pair = { a: string; b: string; first: number; last: number; n: number };
export const pairsOf = (duels: { id: string; a: string; b: string }[]): Pair[] => {
  const by = new Map<string, Pair>();
  for (const d of duels) {
    const [a, b] = [d.a, d.b].sort() as [string, string]; // one pair whichever side each agent took
    const id = Number(d.id);
    const p = by.get(`${a}|${b}`);
    if (!p) by.set(`${a}|${b}`, { a, b, first: id, last: id, n: 1 });
    else Object.assign(p, { first: Math.min(p.first, id), last: Math.max(p.last, id), n: p.n + 1 });
  }
  return [...by.values()].sort((x, y) => y.last - x.last);
};

/** A stub agent (no model, no proof: "stub/deterministic", "redteam/stub"): "stub" as a whole path segment, so a
 *  real model named e.g. "stubborn-model" is not one. Same rule as `is_stub_model` in agents/nearai.py. Standings hide
 *  these behind a toggle, and pair rows skip a pair with one in it. An unknown model id is not a stub. */
export const isStubModel = (modelId: string | null | undefined) => !!modelId && /(^|\/)stub(\/|$)/.test(modelId);

/** The pairs box 2 lists: running pairs only (a one-off duel is a probe, not a pair), without pairs where `hide`
 *  is true for either agent (stubs), the `max` most recently active kept, then shown oldest first so "pair 1" is
 *  the one that started first. Empty unless 2+ are left. */
export const shownPairs = (
  pairs: Pair[] | null | undefined,
  hide: (pk: string) => boolean = () => false,
  max = 3,
): Pair[] => {
  const running = (pairs ?? []).filter((p) => p.n > 1 && !hide(p.a) && !hide(p.b));
  if (running.length < 2) return [];
  return running
    .sort((x, y) => y.last - x.last)
    .slice(0, max)
    .sort((x, y) => x.first - y.first);
};

/** One pair row: both models (cut to 26, linked to their agent pages), the duel span and the count in the window. */
export const pairCells = (p: Pair, model: (pk: string) => string, scanned: number | undefined): Cell[] => [
  { t: model(p.a).slice(0, 26), href: agentHref(p.a), title: p.a },
  " vs ",
  { t: model(p.b).slice(0, 26), href: agentHref(p.b), title: p.b },
  { t: `  #${p.first}-#${p.last} · ${p.n} of last ${scanned ?? "?"}`, c: "dim" },
];

/** Columns for an injection's `kind` in the attack rows. */
export const KIND_W = 15;
/** An injection's on-chain `kind` in `width` columns. The spectator writes "fake_news/<against|flat>/<bps|no_open>"
 *  (packages/demo/src/spectator.ts): shown as "against -57.7" or "flat no_open", the full kind on hover. An older
 *  plain kind ("fake_news") shows as is. A longer label is cut with "…", so the row keeps its columns. */
export const kindCell = (kind: string, width = KIND_W): Cell => {
  const [base, mode, move] = kind.split("/");
  const label = mode ? `${mode} ${move ?? ""}`.trimEnd() : (base ?? "");
  const t = label.length > width ? `${label.slice(0, width - 1)}…` : label.padEnd(width);
  return mode ? { t, title: kind } : t;
};

/** GET /api/verify: a resolved duel re-checked from public sources (the CLI's `verify-duel`), or "open". */
export type VerifyLine = { result: "PASS" | "FAIL" | "SKIP" | "INFO"; check: string; detail: string };
export type Verify = {
  duel_id: string;
  status: "checked" | "open" | "missing";
  command: string;
  counts?: Record<VerifyLine["result"], number>;
  lines?: VerifyLine[];
  degraded?: boolean;
};
const VERIFY_CLASS = { PASS: "ok", FAIL: "loss", SKIP: "warn", INFO: "dim" } as const;
const VERIFY_HINT = {
  PASS: "re-derived from public data and matches the contract",
  FAIL: "public data contradicts the contract's record",
  SKIP: "not checkable from the data at hand (see the line)",
  INFO: "context, not a check",
} as const;

/** Duel box 4, `verified` row: the counts (FAIL red even at 0 so a reader sees it was counted), then the toggle. */
export const verifySummary = (v: Verify, open: boolean, toggle: () => void): Cell[] =>
  v.counts
    ? [
        ...(["PASS", "FAIL", "SKIP", "INFO"] as const).flatMap((r, i): Cell[] => [
          i ? { t: " · ", c: "dim" } : "",
          { t: `${v.counts?.[r] ?? 0} ${r}`, c: VERIFY_CLASS[r], title: VERIFY_HINT[r] },
        ]),
        v.degraded ? { t: "  (a past-block read failed, retrying)", c: "dim" } : "",
        "   ",
        { t: open ? "hide lines" : `show ${v.lines?.length ?? 0} lines`, onClick: toggle },
      ]
    : [{ t: v.status, c: "dim" }];

/** One verifier line: result, check, detail (cut at the box edge, whole on hover). */
export const verifyLineCells = (l: VerifyLine): Cell[] => [
  { t: l.result.padEnd(4), c: VERIFY_CLASS[l.result] },
  "  ",
  { t: l.check.slice(0, 26).padEnd(26), c: "dim" },
  " ",
  { t: l.detail, title: l.detail },
];

// ---------------------------------------------------------------- the follower page (GET /api/follower)

/** One successful arena call by or for the follower, from its own txs. */
export type FollowerActivity = {
  kind: "follow" | "unfollow" | "deposit" | "request_withdraw" | "withdraw" | "withdraw_token";
  tx: string;
  at_ms: number;
  agent_pk?: string;
  amount?: string; // yoctoNEAR, or token units for withdraw_token
  token?: string;
};
/** One fill a solver settled for a follower: the vault paid amount_in (+ fee), the holding gained amount_out. */
export type SettledFill = {
  tx: string;
  at_ms: number;
  follower: string;
  agent_pk: string;
  solver: string;
  intent_nonce: string;
  token: string;
  amount_in: string;
  amount_out: string;
  swap_tx: string;
};
export type MandateView = {
  allowance: string;
  spent: string;
  per_tx_cap: string;
  allowed_tokens: string[];
  expires_at: string;
  revoked: boolean;
  min_out_per_near?: string;
  revoked_at?: string;
};
export type FollowerRec = {
  at: number;
  account: string;
  arena: string;
  /** false on a contract before deploy 15 (no pending withdrawals, holdings or per-pair mandates). */
  deploy15: boolean;
  vault: string | null;
  pending: { amount: string; ready_at: string } | null;
  holdings: { token: string; amount: string }[];
  mandates: { agent_pk: string; model_id: string | null; mandate: MandateView | null }[];
  fills: SettledFill[];
  /** How far back the arena's txs were read for fills: to the first follow when `complete`. */
  fills_scan: { from_ms: number | null; oldest_ms: number | null; txs: number; complete: boolean };
  activity: FollowerActivity[];
};

/** intents.near token ids the solver settles in (packages/solver/src/oneclick.ts), with their decimals. */
export const TOKENS: Record<string, { name: string; decimals: number }> = {
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { name: "USDC", decimals: 6 },
  "nep141:wrap.near": { name: "wNEAR", decimals: 24 },
};
export const tokenName = (id: string) => {
  const s = id.replace(/^nep141:/, "");
  return TOKENS[id]?.name ?? (s.length > 12 ? short(s, 12) : s);
};
/** A token amount in display units, 4 dp, floored; an unknown token shows its raw base units. */
export const tokenAmount = (id: string, amount: string) => {
  const t = TOKENS[id];
  if (!t) return amount;
  const v = BigInt(amount);
  const unit = 10n ** BigInt(t.decimals);
  return `${v / unit}.${(((v % unit) * 10_000n) / unit).toString().padStart(4, "0")}`;
};
/** A mandate's state as settle_follow sees it: revoked, expired, or active. */
export const mandateState = (m: MandateView, nowMs: number) =>
  m.revoked ? "revoked" : Number(BigInt(m.expires_at) / 1_000_000n) <= nowMs ? "expired" : "active";

const hhmm = (atMs: number) => new Date(atMs).toISOString().slice(5, 16).replace("T", " "); // "11-07 01:12"
const MODEL_W = 22;
/** An agent's model name (org cut) linked to its page, padded to one column. */
const agentCell = (pk: string, model: string | null | undefined): Cell[] => {
  const m = (model?.split("/").pop() ?? short(pk, 8)).slice(0, MODEL_W);
  return [{ t: m, href: agentHref(pk), title: pk }, " ".repeat(MODEL_W - m.length)];
};

/** Follower box 2: one mandate. */
export const mandateCells = (pk: string, model: string | null, m: MandateView | null, nowMs: number): Cell[] => {
  if (!m) return [...agentCell(pk, model), { t: "  no mandate on chain", c: "dim" }];
  const state = mandateState(m, nowMs);
  return [
    ...agentCell(pk, model),
    "  ",
    { t: state.padEnd(7), c: state === "active" ? "ok" : "loss" },
    `  cap ${near(m.per_tx_cap)}  spent ${near(m.spent)}/${near(m.allowance)} NEAR`,
    {
      t: `  until ${hhmm(Number(BigInt(m.expires_at) / 1_000_000n))}`,
      c: "dim",
      title: `tokens: ${m.allowed_tokens.map(tokenName).join(", ") || "any"}; price floor ${m.min_out_per_near ?? "0"} out per NEAR`,
    },
  ];
};

/** Follower box 3: one settled fill, vault NEAR in, token out, the settle tx. */
export const settledFillCells = (f: SettledFill, model: string | null): Cell[] => [
  { t: hhmm(f.at_ms), c: "dim" },
  "  ",
  ...agentCell(f.agent_pk, model),
  `  ${near(f.amount_in).padStart(6)} NEAR → ${tokenAmount(f.token, f.amount_out).padStart(9)} ${tokenName(f.token).padEnd(5)}`,
  "  tx ",
  {
    t: short(f.tx, 10),
    href: txHref(f.tx),
    title: `settle_follow ${f.tx}, intent nonce ${f.intent_nonce}, swap ${f.swap_tx}`,
  },
];

const ACTIVITY_WORD: Record<FollowerActivity["kind"], string> = {
  follow: "follow",
  unfollow: "unfollow",
  deposit: "deposit",
  request_withdraw: "ask withdraw",
  withdraw: "withdraw",
  withdraw_token: "token out",
};
/** Follower box 4: one of its own calls that went through. */
export const activityCells = (a: FollowerActivity, model: string | null): Cell[] => [
  { t: hhmm(a.at_ms), c: "dim" },
  "  ",
  ACTIVITY_WORD[a.kind].padEnd(12),
  "  ",
  ...(a.agent_pk
    ? agentCell(a.agent_pk, model)
    : [
        a.kind === "withdraw_token"
          ? `${tokenAmount(a.token ?? "", a.amount ?? "0")} ${tokenName(a.token ?? "")}`.padEnd(MODEL_W)
          : `${near(a.amount)} NEAR`.padEnd(MODEL_W),
      ]),
  "  tx ",
  { t: short(a.tx, 10), href: txHref(a.tx), title: a.tx },
];
