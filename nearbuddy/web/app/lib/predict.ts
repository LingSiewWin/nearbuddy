// Free predictions on the arena (predict/ contract): will the model be fooled (`Flipped` / `Held`, per chaos
// injection), and who wins the duel (`A` / `B` / `Tie`). No stake: `predict` attaches a storage deposit that `claim`
// pays back once the call is scored. Views go straight to the public RPC (no API route), typed from
// abi/predict.json; calls are signed by the connected wallet (wallet.ts).
import { NET, NETWORK_ID } from "../network";
import type { MarketView, Pick, PredictCalls, PredictionView, PredictViews } from "./abi/predict";
import type { Call } from "./inject";
import * as wallet from "./wallet";

/** The predict contract; NEXT_PUBLIC_PREDICT_CONTRACT overrides. None on mainnet until one is deployed. */
export const PREDICT: string | null =
  process.env.NEXT_PUBLIC_PREDICT_CONTRACT ?? (NETWORK_ID === "testnet" ? "nb-predict-1111.testnet" : null);
/** The contract's `DEPOSIT` (0.003 NEAR, also `get_config().deposit`): exactly this is attached to `predict`. */
export const DEPOSIT = "3000000000000000000000";
// two arena views (10 TGas each) plus the callback's 15 TGas floor; measured burn is in predict/README.md
const GAS_PREDICT = "60000000000000";
// two arena views plus a scoring page of up to 50 calls
const GAS_SETTLE = "200000000000000";
const GAS_CLAIM = "30000000000000";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** One predict view; the method name types args and result. Tries the network's RPC, then its fallback. */
export async function predictView<M extends keyof PredictViews>(
  method: M,
  args: PredictViews[M]["args"],
  fetcher: typeof fetch = fetch,
): Promise<PredictViews[M]["result"]> {
  if (!PREDICT) throw new Error("no predict contract on this network");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "predict",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: PREDICT,
      method_name: method,
      args_base64: b64(JSON.stringify(args)),
    },
  });
  let last: unknown = null;
  for (const rpc of [NET.rpc, NET.fallback]) {
    try {
      const r = await fetcher(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = (await r.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
      if (!j.result?.result) throw new Error(JSON.stringify(j.error ?? j.result?.error ?? j).slice(0, 160));
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

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

const SAYS: Record<Pick, string> = {
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
