// One match's feed: what each model said (from the chat-completion body a keeper submitted with submit_completion)
// and the paid shouts planted at it (get_chaos), in time order. Text here is untrusted: it is returned as written and
// the page renders it as text only. No Node API.
import { replyOf } from "./fool";

/** A model's decision. `side` and `size_bps` are what its reply states; null when the reply states none. */
export type Said = {
  kind: "model";
  /** Block time in ns. */
  at: string;
  model: string;
  side: "Long" | "Short" | null;
  size_bps: number | null;
  text: string;
  tx: string;
};
export type Shout = {
  kind: "shout";
  at: string;
  /** Its place in the duel's `get_chaos`. */
  index: number;
  by: string;
  target: "A" | "B";
  text: string | null;
  arm: string | null;
  outcome: string;
};
export type FeedLine = Said | Shout;

export const MAX_LINES = 200;

/** How long a built feed stays good, in ms: 3 s while the match is open, 60 s once resolved (late receipts may still
 *  land), and for good an hour after its close, so an old match is scanned once and never again. */
export const keepFor = (resolved: boolean, closeMs: number, nowMs: number): number =>
  !resolved ? 3_000 : nowMs - closeMs > 3_600_000 ? Number.POSITIVE_INFINITY : 60_000;

/** The model's own words out of a chat-completion body: the reply's `reasoning` when the reply is the JSON the prompt
 *  asks for, else the reply as written; a body that is no chat completion comes back whole. Never throws. */
export function saidOf(responseJson: string): { side: "Long" | "Short" | null; size_bps: number | null; text: string } {
  let content = responseJson;
  try {
    const c = (JSON.parse(responseJson) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message
      ?.content;
    if (typeof c === "string") content = c;
  } catch {}
  let side: "Long" | "Short" | null = null;
  let size_bps: number | null = null;
  const m = content.match(/\{[\s\S]*\}/);
  if (m)
    try {
      const d = JSON.parse(m[0]) as { direction?: unknown; size_bps?: unknown };
      const dir = typeof d.direction === "string" ? d.direction.toLowerCase() : "";
      side = dir === "long" ? "Long" : dir === "short" ? "Short" : null;
      size_bps = Number.isInteger(d.size_bps) ? (d.size_bps as number) : null;
    } catch {}
  return { side, size_bps, text: replyOf(content) };
}

const before = (x: FeedLine, y: FeedLine) => {
  const a = BigInt(x.at);
  const b = BigInt(y.at);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Both kinds oldest first, keeping the newest `MAX_LINES`. */
export const merge = (said: Said[], shouts: Shout[]): FeedLine[] => [...said, ...shouts].sort(before).slice(-MAX_LINES);
