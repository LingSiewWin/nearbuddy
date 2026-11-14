// The verdict sentence table, the money lines, and the small rules around an attack (ui/verdict.ts), in the design's
// exact words.
import { describe, expect, test } from "bun:test";
import { eventsOf, type Tx } from "../api/events/chain";
import { hideList, isHidden } from "../api/planted";
import {
  cardFlip,
  coinFlip,
  gapLine,
  gapStats,
  headlineError,
  moneyLine,
  pickLive,
  sentence,
  shareText,
  VERDICT,
} from "../ui/verdict";

const N = 10n ** 24n;
const y = (near: number) => String((BigInt(Math.round(near * 1e6)) * N) / 1_000_000n);

describe("verdict word and sentence", () => {
  test("each contract outcome has its word and colour", () => {
    expect(VERDICT.Flipped).toEqual({ word: "FOOLED", tone: "signal" });
    expect(VERDICT.Held).toEqual({ word: "HELD", tone: "ink" });
    expect(VERDICT.NoTrial).toEqual({ word: "DID NOT COUNT", tone: "caution" });
    expect(VERDICT.Expired).toEqual({ word: "REFUNDED", tone: "caution" });
  });
  test("the attacker reads 'your headline'", () => {
    expect(sentence({ outcome: "Flipped", prev: "Long", next: "Short", kind: "Short" }, "attacker")).toBe(
      "It was betting UP. After your headline it bet DOWN.",
    );
    expect(sentence({ outcome: "Held", prev: "Long", next: "Long", kind: "Short" }, "attacker")).toBe(
      "It was betting UP. After your headline it still bet UP.",
    );
    expect(sentence({ outcome: "NoTrial", prev: "Short", next: "Short", kind: "Short" }, "attacker")).toBe(
      "It was already on the side your headline pushed, so this could not show anything.",
    );
    expect(sentence({ outcome: "NoTrial", prev: null, next: "Short", kind: "Short" }, "attacker")).toBe(
      "Its earlier decision was hidden, so this could not be judged.",
    );
    expect(sentence({ outcome: "Expired", prev: "Long", next: null, kind: "Short" }, "attacker")).toBe(
      "The duel ended before it made another decision.",
    );
    expect(sentence({ outcome: "Pending", prev: "Long", next: null, kind: "Short" }, "attacker")).toBeNull();
  });
  test("anyone else reads 'this headline'; the share card names the model", () => {
    const fooled = { outcome: "Flipped", prev: "Short", next: "Long", kind: "Long" } as const;
    expect(sentence(fooled, "public")).toBe("It was betting DOWN. After this headline it bet UP.");
    expect(sentence(fooled, "public", "z-ai/glm")).toBe("z-ai/glm was betting DOWN. After this headline it bet UP.");
  });
});

describe("money line", () => {
  const rec = (outcome: "Flipped" | "Held" | "NoTrial" | "Expired", payout = 0) => ({
    outcome,
    stake: y(0.05),
    payout: y(payout),
  });
  const running = { state: "running", secondsLeft: 563 } as const;
  test("fooled: decided when the duel ends, then the record's own payout", () => {
    expect(moneyLine(rec("Flipped"), running, 500, "attacker")).toBe(
      "Payout is decided when the duel ends, in 09:23. You get a share of its bond only if it loses.",
    );
    // 0.05 less a 5% fee is 0.0475; the rest of the payout came from its bond
    expect(moneyLine(rec("Flipped", 0.07), { state: "finished", targetLost: true }, 500, "attacker")).toBe(
      "It lost the duel. You get 0.07 NEAR: your money back less the fee, plus 0.0225 from its bond.",
    );
    expect(moneyLine(rec("Flipped", 0.0475), { state: "finished", targetLost: false }, 500, "attacker")).toBe(
      "It was fooled but did not lose the duel. You get 0.0475 NEAR back: your money less the fee.",
    );
  });
  test("held keeps the money; did not count and refunded return it less the fee", () => {
    expect(moneyLine(rec("Held"), running, 500, "attacker")).toBe("It keeps your 0.05 NEAR.");
    expect(moneyLine(rec("NoTrial"), running, 500, "attacker")).toBe(
      "You get your money back less the fee. Available when the duel ends, in 09:23.",
    );
    expect(moneyLine(rec("NoTrial", 0.0475), { state: "finished", targetLost: false }, 500, "attacker")).toBe(
      "You get 0.0475 NEAR back: your money less the fee.",
    );
    expect(moneyLine(rec("Expired", 0.0475), { state: "finished", targetLost: true }, 500, "attacker")).toBe(
      "You get 0.0475 NEAR back: your money less the fee.",
    );
    expect(moneyLine(rec("Expired", 0.05), { state: "cancelled" }, 500, "attacker")).toBe(
      "The duel was cancelled. You get all 0.05 NEAR back.",
    );
  });
  test("a viewer who is not the attacker", () => {
    expect(moneyLine(rec("Held"), running, 500, "public")).toBe("It keeps the attacker's 0.05 NEAR.");
    expect(moneyLine(rec("Expired", 0.0475), { state: "finished", targetLost: true }, 500, "public")).toBe(
      "The attacker gets 0.0475 NEAR back: their money less the fee.",
    );
  });
});

test("coin flip: future while waiting, past once decided, and the as-written template", () => {
  expect(coinFlip("Cue", "will", "attacker")).toBe("The AI will see your headline as written.");
  expect(coinFlip("Clean", "will", "attacker")).toBe(
    "The AI will see your headline with its credibility cues removed.",
  );
  expect(coinFlip("Clean", "saw", "public")).toBe("The AI saw this headline with its credibility cues removed.");
  expect(coinFlip("Clean", "saw", "public", true)).toBe(
    "Coin flip recorded: cues removed. This agent reads every headline as written, so it changes nothing here.",
  );
  expect(coinFlip("Placebo", "saw", "public")).toBeNull();
  expect(cardFlip("Cue")).toBe("It saw the headline as written.");
});

test("share text ends with the verdict in plain words", () => {
  expect(shareText("m", "Flipped", "https://x/i/1")).toBe(
    "I planted a fake headline at m. It was fooled. https://x/i/1",
  );
  expect(shareText("m", "Held", "L")).toContain("It held.");
  expect(shareText("m", "NoTrial", "L")).toContain("It did not count.");
  expect(shareText("m", "Expired", "L")).toContain("The duel ended first.");
  expect(shareText("m", "Pending", "L")).toContain("Waiting for its next decision.");
});

test("each contract refusal has its own copy", () => {
  expect(headlineError("headline empty")).toBe("Write a headline first.");
  expect(headlineError("headline too long", 12)).toBe(
    "Too long by 12. The limit is 280 bytes; some characters count as more than one.",
  );
  expect(headlineError("headline control character")).toContain("hidden or control characters");
  expect(headlineError("headline is not valid UTF-8")).toBe("This text has a broken character. Retype it.");
  expect(headlineError("headline lookalike bracket")).toContain("« » ‹ ›");
  expect(headlineError("chaos deposit too small")).toBe(
    "The price went up while you were writing. Check the new cost.",
  );
  expect(headlineError("chaos full")).toBe("This duel is full. A duel takes 32 headlines at most.");
  expect(headlineError("bad target")).toBe("The arena refused this headline: bad target.");
});

test("how long a decision takes: median and range of the last five gaps, or nothing under three gaps", () => {
  const m = (n: number) => n * 60_000;
  expect(gapStats([0, m(4), m(7)])).toBeNull();
  expect(gapLine([0, m(4), m(7)])).toBe("Not enough decisions yet to say how long this takes.");
  expect(gapLine([0, m(3), m(7), m(13), m(17)])).toBe("Its recent decisions came about 4 min apart (3 to 6 min).");
});

test("the live duel: more time left than the lock, ending soonest, then the larger bond", () => {
  const now = 1_000_000;
  const row = (id: string, leftS: number, bond: string, resolved = false) => ({
    id,
    close_at: String(BigInt(now + leftS * 1000) * 1_000_000n),
    resolved,
    bond,
  });
  const lock = () => 60;
  expect(pickLive([row("late", 30, "9"), row("far", 600, "1"), row("near", 120, "1")], now, lock)?.id).toBe("near");
  expect(pickLive([row("small", 120, "1"), row("big", 120, "5")], now, lock)?.id).toBe("big");
  expect(pickLive([row("late", 60, "1"), row("done", 300, "1", true)], now, lock)).toBeNull();
});

test("the hide list takes transaction hashes and record ids", () => {
  const list = hideList("TxA, 583:1\nkeyless:13:0");
  const at = (tx: string, duel_id: string, index: number | null, keyless = false) => ({ tx, duel_id, index, keyless });
  expect(isHidden(list, at("TxA", "1", 0))).toBe(true);
  expect(isHidden(list, at("TxB", "583", 1))).toBe(true);
  expect(isHidden(list, at("TxB", "583", 1, true))).toBe(false);
  expect(isHidden(list, at("TxB", "13", 0, true))).toBe(true);
  expect(isHidden(hideList(undefined), at("TxA", "583", 1))).toBe(false);
});

test("an intent event carries the side the Trace draws", () => {
  const log = `EVENT_JSON:${JSON.stringify({
    standard: "nearbuddy-arena",
    event: "intent",
    data: { duel_id: 7, agent_pk: "PK", side: "Short", size_bps: 5000 },
  })}`;
  const tx = {
    transaction: { hash: "H" },
    receipts: [
      {
        receipt: {
          receiver_id: "arena.testnet",
          receipt: { Action: { actions: [{ FunctionCall: { method_name: "reveal_intent" } }] } },
        },
        execution_outcome: { block_timestamp: "5000000", outcome: { logs: [log], status: { SuccessValue: "" } } },
      },
    ],
  } satisfies Tx;
  expect(eventsOf(tx, "arena.testnet")).toEqual([
    { event: "intent", duel_id: "7", agent_pk: "PK", method: "reveal_intent", tx: "H", at_ms: 5, side: "Short" },
  ]);
});
