"use client";
// One free prediction pane: the market's picks as buttons (Flipped / Held for a planted headline, A / B / Tie for
// the duel), the crowd's split, and after `settle` whether the viewer was right. Self-contained: it polls the predict
// contract's views itself and signs through the wallet; the page only says which market it is on.
import { useCallback, useEffect, useState } from "react";
import type { MarketView, Pick, PredictionView } from "../lib/abi/predict";
import {
  claimCall,
  crowdLine,
  mine,
  PREDICT,
  picksOf,
  predictCall,
  predictView,
  resultLine,
  send,
  settleCall,
  split,
} from "../lib/predict";
import * as wallet from "../lib/wallet";
import { Box, Line, Note } from "./box";

const POLL_MS = 5_000;

export default function Predict({
  duelId,
  index,
  w,
  on = false,
}: {
  duelId: string;
  /** The injection's index in the arena's `get_chaos(duelId)`; null for the duel's winner. */
  index: number | null;
  w: number;
  on?: boolean;
}) {
  const [account, setAccount] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [held, setHeld] = useState<PredictionView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!PREDICT) return;
    try {
      const [m, h] = await Promise.all([
        predictView("get_market", { duel_id: duelId, index }),
        account ? predictView("get_predictions", { account }) : Promise.resolve(null),
      ]);
      setMarket(m);
      setHeld(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [duelId, index, account]);

  useEffect(() => {
    let off = () => {};
    void wallet.account().then(setAccount);
    void wallet.onChange(setAccount).then((f) => {
      off = f;
    });
    return () => off();
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pick = (p: Pick) =>
    act(p, async () => {
      const who = account ?? (await wallet.signIn());
      if (!who) throw new Error("connect a wallet to predict");
      setAccount(who);
      await send(predictCall(duelId, index, p));
    });

  const id = `predict-${duelId}-${index ?? "duel"}`;
  const title = index === null ? "who wins?" : "will the model be fooled?";
  if (!PREDICT) {
    return (
      <Box n="?" title={title} w={w} on={on} id={id}>
        <Line w={w} cells={[{ t: "predictions are not deployed on this network", c: "dim" }]} />
      </Box>
    );
  }

  const me = mine(held, duelId, index);
  const open = !market?.settled;
  const shares = split(market);
  return (
    <Box n="?" title={title} extra="free · deposit back" w={w} on={on} id={id}>
      {picksOf(index).map((p) => {
        const s = shares.find((x) => x.pick === p);
        const chosen = me?.pick === p;
        return (
          <Line
            key={p}
            w={w}
            sel={chosen}
            label={`predict ${p}`}
            onClick={open && !me && !busy ? () => void pick(p) : undefined}
            cells={[
              { t: chosen ? "▸ " : "  ", c: "hi" },
              { t: `${p}`.padEnd(8), c: open && !me ? "hi" : "dim" },
              { t: `${String(s?.pct ?? 0).padStart(3)}%  `, c: "dim" },
              { t: "█".repeat(Math.round((s?.pct ?? 0) / 10)), c: p === market?.outcome ? "ok" : "dim" },
            ]}
          />
        );
      })}
      <Note w={w} text={crowdLine(market) ?? "no calls yet: be the first"} />
      {me ? <Note w={w} c={me.verdict === "Right" ? "ok" : "dim"} text={resultLine(me) ?? ""} /> : null}
      {me && !me.verdict ? (
        <Line
          w={w}
          label="settle this duel"
          onClick={busy ? undefined : () => void act("settle", () => send(settleCall(duelId)))}
          cells={[{ t: busy === "settle" ? "settling…" : "check the result (settle)", c: "dim" }]}
        />
      ) : null}
      {me?.verdict ? (
        <Line
          w={w}
          label="claim deposits"
          onClick={busy ? undefined : () => void act("claim", () => send(claimCall()))}
          cells={[{ t: busy === "claim" ? "claiming…" : "claim your deposit back", c: "hi" }]}
        />
      ) : null}
      {!open && !me ? <Note w={w} text="closed: the model has answered" /> : null}
      {busy && busy !== "settle" && busy !== "claim" ? <Note w={w} text="sign in your wallet…" /> : null}
      {error ? <Note w={w} c="err" text={error} /> : null}
    </Box>
  );
}
