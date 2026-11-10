// Free predictions on the arena (predict/ contract): will the model be fooled (`Flipped` / `Held`, per chaos
// injection), and who wins the duel (`A` / `B` / `Tie`). No stake: `predict` attaches a storage deposit that `claim`
// pays back once the call is scored (the first claim keeps back the caller's board row, at most 0.00141 NEAR, once).
// The page reads the views through GET /api/predict (api/predict.ts), typed from abi/predict.json; calls are signed by
// the connected wallet (wallet.ts).
import { NETWORK_ID } from "../network";
import type { MarketView, Pick, PredictCalls, PredictionView } from "./abi/predict";
import type { Call } from "./inject";
import * as wallet from "./wallet";

/** The predict contract; NEXT_PUBLIC_PREDICT_CONTRACT overrides. None on mainnet until one is deployed. */
export const PREDICT: string | null =
  process.env.NEXT_PUBLIC_PREDICT_CONTRACT ?? (NETWORK_ID === "testnet" ? "nb-predict-v3-1111.testnet" : null);
/** The contract's `DEPOSIT` (0.0041 NEAR, also `get_config().deposit`): exactly this is attached to `predict`. */
export const DEPOSIT = "4100000000000000000000";
/** DEPOSIT in NEAR, as the page says it ("0.0041"). */
export const DEPOSIT_NEAR = String(Number(BigInt(DEPOSIT) / 10n ** 16n) / 1e8);
// two arena views (10 TGas each) plus the callback's 15 TGas floor; measured burn is in predict/README.md
const GAS_PREDICT = "60000000000000";
// two arena views plus a scoring page of up to 50 calls
const GAS_SETTLE = "200000000000000";
const GAS_CLAIM = "30000000000000";

const call = <M extends keyof PredictCalls>(
  methodName: M,
  args: PredictCalls[M]["args"],
  gas: string,
  deposit: string,
): Call => {
  if (!PREDICT) throw new Error("no predict contract on this network");
  return { receiverId: PREDICT, methodName, args, gas, deposit };
};

/** `predict`: `index` is the injection's index in the arena's `get_chaos(duel_id)`, or null for the duel itself. */
export const predictCall = (duel_id: string, index: number | null, pick: Pick) =>
  call("predict", { duel_id, index, pick }, GAS_PREDICT, DEPOSIT);
/** `settle`: anyone; scores every call on the duel's decided markets (repeat while it returns more than 0). */
export const settleCall = (duel_id: string) => call("settle", { duel_id }, GAS_SETTLE, "0");
/** `claim`: pays the signer back the deposits of all its scored calls. */
export const claimCall = () => call("claim", {}, GAS_CLAIM, "0");

/** Signs one predict call with the connected wallet; resolves with the tx hash. A call the arena shows closed is
 *  refunded in the callback, not refused, so read `get_predictions` afterwards to see whether it landed. */
export const send = (c: Call) => wallet.send(c);

/** The picks a market takes, in the order the contract lists them. */
export const picksOf = (index: number | null): Pick[] => (index === null ? ["A", "B", "Tie"] : ["Flipped", "Held"]);

/** Each pick's share of the crowd in whole percent (0 for all while nobody has called). */
export const split = (m: MarketView | null): { pick: Pick; n: number; pct: number }[] =>
  (m?.picks ?? []).map((p) => ({ ...p, pct: m?.total ? Math.round((100 * p.n) / m.total) : 0 }));

/** A pick in words: "it will hold", "A wins". */
export const SAYS: Record<Pick, string> = {
  Flipped: "it will be fooled",
  Held: "it will hold",
  A: "A wins",
  B: "B wins",
  Tie: "a tie",
};

/** "71% say it will hold": the crowd's leading pick, or null with no calls yet. */
export function crowdLine(m: MarketView | null): string | null {
  const s = split(m);
  const top = s.reduce<(typeof s)[number] | null>((a, b) => (!a || b.n > a.n ? b : a), null);
  if (!top?.n) return null;
  return `${top.pct}% say ${SAYS[top.pick]}`;
}

/** The account's call on one market among the ones it holds (claimed calls are gone from this list). */
export const mine = (held: PredictionView[] | null, duel_id: string, index: number | null) =>
  held?.find((p) => p.duel_id === duel_id && p.index === index) ?? null;

/** Why a market's answer may not be blind, for the page to say next to the buttons; null when it is. A duel market
 *  is never blind: each keyed agent's owner picks which replies its key signs (predict/README.md). */
export function steerLine(m: MarketView | null): string | null {
  if (!m) return null;
  if (m.index === null) return "either agent's owner can steer this: it picks the replies its agent signs";
  if (m.steered_by) return `the agent's owner ${m.steered_by} picks which reply it signs, so it can steer this`;
  if (m.open_until_reveal) return "closes at the reveal: whoever runs the agent knows the answer first";
  return null;
}

/** What the predictor sees about their call. */
export function resultLine(p: PredictionView | null): string | null {
  if (!p) return null;
  switch (p.verdict) {
    case null:
      return `you said ${SAYS[p.pick]} · waiting for the model`;
    case "Right":
      return `you were right: you said ${SAYS[p.pick]}`;
    case "Wrong":
      return `you were wrong: you said ${SAYS[p.pick]}`;
    case "Void":
      return "no trial: not scored, deposit refundable";
  }
}
