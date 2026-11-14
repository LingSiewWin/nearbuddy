// What a planted headline's record means, in the design's exact words: the verdict word, the one sentence, the money
// line, the coin-flip line, the share text, and the copy for each refusal. Pure, so the result page, the duel page
// and the share card are built from the same record and never disagree.
import type { Arm, Chaos, ChaosOutcome } from "../lib/abi/arena";
import { bet, clock, near, type Side } from "./format";

export type Word = "FOOLED" | "HELD" | "DID NOT COUNT" | "REFUNDED";
export type Tone = "signal" | "ink" | "caution";
export const VERDICT: Record<Exclude<ChaosOutcome, "Pending">, { word: Word; tone: Tone }> = {
  Flipped: { word: "FOOLED", tone: "signal" },
  Held: { word: "HELD", tone: "ink" },
  NoTrial: { word: "DID NOT COUNT", tone: "caution" },
  Expired: { word: "REFUNDED", tone: "caution" },
};

type Rec = Pick<Chaos, "outcome" | "prev" | "next" | "kind">;
/** Who reads the page: the attacker ("your headline") or anyone else ("this headline"). */
export type Viewer = "attacker" | "public";

/** The one sentence under a verdict. `who` opens it: "It" on the page, the model id on the share card. Null while
 *  the headline is still waiting. */
export function sentence(c: Rec, viewer: Viewer, who = "It"): string | null {
  const the = viewer === "attacker" ? "your" : "this";
  const was = c.prev ? `${who} was betting ${bet(c.prev)}.` : "";
  switch (c.outcome) {
    case "Pending":
      return null;
    case "Flipped":
      return `${was} After ${the} headline it bet ${bet((c.next ?? c.kind) as Side)}.`.trim();
    case "Held":
      return `${was} After ${the} headline it still bet ${bet((c.next ?? c.prev) as Side)}.`.trim();
    case "NoTrial":
      return c.prev
        ? `It was already on the side ${the} headline pushed, so this could not show anything.`
        : "Its earlier decision was hidden, so this could not be judged.";
    case "Expired":
      return "The duel ended before it made another decision.";
  }
}

/** Where the duel stands, for the money line. */
export type DuelEnd =
  | { state: "running"; secondsLeft: number }
  | { state: "closed" } // time is up, the final price is not in
  | { state: "finished"; targetLost: boolean }
  | { state: "cancelled" };

/** One sentence saying what happens to the money. After the duel finishes it prints the record's own `payout` and
 *  never recomputes it; the bond share is that payout less the money locked net of the attack fee. */
export function moneyLine(
  c: Pick<Chaos, "outcome" | "stake" | "payout">,
  end: DuelEnd,
  feeBps: number,
  viewer: Viewer,
): string | null {
  const you = viewer === "attacker";
  const get = you ? "You get" : "The attacker gets";
  const money = you ? "your money" : "their money";
  const done = end.state === "finished" || end.state === "cancelled";
  const back = (tail = "") =>
    done ? `${get} ${near(c.payout)} back: ${money} less the fee.${tail}` : `${get} ${money} back less the fee.${tail}`;
  const whenEnds = end.state === "running" ? ` Available when the duel ends, in ${clock(end.secondsLeft)}.` : "";
  switch (c.outcome) {
    case "Pending":
      return null;
    case "Flipped": {
      if (end.state === "running")
        return `Payout is decided when the duel ends, in ${clock(end.secondsLeft)}. ${get} a share of its bond only if it loses.`;
      if (end.state === "closed")
        return `Payout is decided when the duel ends. ${get} a share of its bond only if it loses.`;
      if (end.state === "finished" && end.targetLost) {
        const net = BigInt(c.stake) - (BigInt(c.stake) * BigInt(feeBps)) / 10_000n;
        const share = BigInt(c.payout) - net;
        return `It lost the duel. ${get} ${near(c.payout)}: ${money} back less the fee, plus ${near(share > 0n ? share : 0n).replace(" NEAR", "")} from its bond.`;
      }
      return `It was fooled but did not lose the duel. ${get} ${near(c.payout)} back: ${money} less the fee.`;
    }
    case "Held":
      return `It keeps ${you ? "your" : "the attacker's"} ${near(c.stake)}.`;
    case "NoTrial":
      return back(whenEnds);
    case "Expired":
      return end.state === "cancelled" ? `The duel was cancelled. ${get} all ${near(c.payout)} back.` : back();
  }
}

/** The coin flip the contract recorded (`arm`). `asWritten`: the agent's template delivers every headline as written
 *  (keyless template 1), so the flip changes nothing. Future tense while waiting, past once decided. */
export function coinFlip(arm: Arm, tense: "will" | "saw", viewer: Viewer, asWritten = false): string | null {
  if (arm === "Placebo") return null;
  if (asWritten)
    return `Coin flip recorded: ${arm === "Cue" ? "as written" : "cues removed"}. This agent reads every headline as written, so it changes nothing here.`;
  const the = viewer === "attacker" ? "your" : "this";
  const how = arm === "Cue" ? "as written" : "with its credibility cues removed";
  return tense === "will" ? `The AI will see ${the} headline ${how}.` : `The AI saw ${the} headline ${how}.`;
}

/** The share card's second line. */
export const cardFlip = (arm: Arm | null): string | null =>
  arm === "Cue"
    ? "It saw the headline as written."
    : arm === "Clean"
      ? "It saw the headline with credibility cues removed."
      : null;

const ENDING: Record<ChaosOutcome, string> = {
  Flipped: "It was fooled.",
  Held: "It held.",
  NoTrial: "It did not count.",
  Expired: "The duel ended first.",
  Pending: "Waiting for its next decision.",
};
/** The prefilled share text. */
export const shareText = (model: string, outcome: ChaosOutcome, link: string) =>
  `I planted a fake headline at ${model}. ${ENDING[outcome]} ${link}`;

/** What stands under the headline field for a refusal, by the contract's own reason. `over`: bytes past the limit. */
export function headlineError(reason: string, over = 0): string {
  if (reason.includes("headline empty")) return "Write a headline first.";
  if (reason.includes("headline too long"))
    return `Too long by ${over}. The limit is 280 bytes; some characters count as more than one.`;
  if (reason.includes("headline control character"))
    return "Remove hidden or control characters. Pasted text sometimes carries them.";
  if (reason.includes("headline is not valid UTF-8")) return "This text has a broken character. Retype it.";
  if (reason.includes("headline hidden character"))
    return "Remove hidden characters. Pasted text sometimes carries them.";
  if (reason.includes("headline lookalike bracket"))
    return "Remove angle-bracket lookalikes such as « » ‹ ›. The arena refuses them.";
  if (reason.includes("chaos deposit too small"))
    return "The price went up while you were writing. Check the new cost.";
  if (reason.includes("chaos full")) return "This duel is full. A duel takes 32 headlines at most.";
  if (reason.includes("paused")) return "The arena is paused. Nothing was charged except a small network fee.";
  return `The arena refused this headline: ${reason}.`;
}

/** How far apart the target's recent decisions came: the median and range of the gaps between its last five, in whole
 *  minutes (at least 1). Null with fewer than three gaps: the page then says it cannot tell. */
export function gapStats(times: number[]): { median: number; min: number; max: number; medianMs: number } | null {
  const last = [...times].sort((a, b) => a - b).slice(-5);
  const gaps = last.slice(1).map((t, i) => t - (last[i] as number));
  if (gaps.length < 3) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const medianMs =
    sorted.length % 2
      ? (sorted[Math.floor(mid)] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  return {
    median: minutes(medianMs),
    min: minutes(sorted[0] as number),
    max: minutes(sorted.at(-1) as number),
    medianMs,
  };
}
export const gapLine = (times: number[]): string => {
  const g = gapStats(times);
  return g
    ? `Its recent decisions came about ${g.median} min apart (${g.min} to ${g.max} min).`
    : "Not enough decisions yet to say how long this takes.";
};

/** The home page's live duel: among the running duels with more time left than the lock period, the one that ends
 *  soonest; between duels ending together, the larger bond total. Null when no running duel can still be attacked. */
export function pickLive<R extends { close_at: string; resolved: boolean; bond: string | null }>(
  rows: R[],
  nowMs: number,
  lockS: (r: R) => number,
): R | null {
  const left = (r: R) => Number(BigInt(r.close_at) / 1_000_000n) - nowMs;
  return (
    rows
      .filter((r) => !r.resolved && left(r) > lockS(r) * 1000)
      .sort((x, y) => left(x) - left(y) || (BigInt(y.bond ?? "0") > BigInt(x.bond ?? "0") ? 1 : -1))[0] ?? null
  );
}
