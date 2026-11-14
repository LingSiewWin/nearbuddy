"use client";
// The attack box: write a fake headline, confirm what it costs and what can happen, pay. Steps 1 to 3 of the attack
// flow; once the headline lands the duel page's YOUR HEADLINE panel takes over. The call is lib/inject.ts's (the
// headline goes on chain, checked first with the contract's own rules) and the wallet or guest account signs it.
import { useEffect, useRef, useState } from "react";
import type { Direction } from "../lib/inject";
import { chaosDeploy17, checkHeadline, isChaosV2, MAX_HEADLINE, utf8Bytes } from "../lib/inject";
import { MAX_INJECTIONS } from "../lib/keyless";
import * as wallet from "../lib/wallet";
import { NET, NETWORK_ID } from "../network";
import { getJson } from "../tui";
import { type Mine, useSite } from "./chrome";
import { type ArenaKind, type DuelBody, duelUrl, type History, phaseOf } from "./data";
import { bet, near, nsMs, other, type Side, TEST_NOTE } from "./format";
import { Button, Details, Field, LinkButton, Segmented, StatusBar } from "./kit";
import { Headline } from "./result";
import { gapStats, headlineError } from "./verdict";

/** Why the attack button is disabled, or null when a headline can be planted now. An empty label: no attack action
 *  at all (the duel is closed or finished). */
export function attackGate(body: DuelBody, now: number): { label: string; why: string } | null {
  const d = body.duel;
  if (!d || phaseOf(d, now) !== "running") return { label: "", why: "" };
  if (!isChaosV2(body.config))
    return {
      label: "Plant a fake headline",
      why: "This arena records your headline but does not judge the result or pay out.",
    };
  if (body.config.paused) return { label: "Attacks are paused", why: "The arena is paused. Try again later." };
  if ((d.chaos?.length ?? d.injections.length) >= MAX_INJECTIONS)
    return { label: "This duel is full", why: "A duel takes 32 headlines at most." };
  if (now && nsMs(d.close_at) - now <= body.config.intent_lock_s * 1000)
    return { label: "Too late for this duel", why: "No new decision can land before it ends." };
  if (!d.last_intent_a && !d.last_intent_b)
    return {
      label: "Plant a fake headline",
      why: "Wait for its first decision. An attack needs a position to push against.",
    };
  return null;
}

/** The account's balance in yoctoNEAR from the public RPC, or null while unread. */
function useBalance(account: string | null, kick: number): bigint | null {
  const [got, setGot] = useState<{ account: string; amount: bigint } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `kick` re-reads after a failed send
  useEffect(() => {
    if (!account) return;
    let alive = true;
    fetch(NET.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: account },
      }),
    })
      .then((r) => r.json())
      .then((j: { result?: { amount?: string } }) => {
        if (alive && j.result?.amount) setGot({ account, amount: BigInt(j.result.amount) });
      })
      .catch(() => {}); // unread: the check is skipped and the chain decides
    return () => {
      alive = false;
    };
  }, [account, kick]);
  return got && got.account === account ? got.amount : null;
}

const FEES = 10n ** 22n; // 0.01 NEAR: "a little for network fees"
type SendError =
  | { kind: "cancelled" | "lost" | "nothing" | "balance" }
  | { kind: "ended" }
  | { kind: "refused"; reason: string };

export function AttackBox({
  body,
  arena,
  histories,
  now,
  target,
  onTarget,
  onPlanted,
  onLock,
  refresh,
}: {
  body: DuelBody;
  arena: ArenaKind;
  histories: { a: History | null; b: History | null };
  now: number;
  target: "a" | "b";
  onTarget: (t: "a" | "b") => void;
  /** The headline landed: the box is done. `tx` is null when it was found on chain after a lost connection. */
  onPlanted: (m: Mine | null) => void;
  /** True while sending: the sheet around the box must not be dismissed. */
  onLock: (locked: boolean) => void;
  /** Re-reads the duel (its price changes with every paid attack). */
  refresh: () => void;
}) {
  const site = useSite();
  const [step, setStep] = useState<"write" | "confirm">("write");
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [pushed, setPushed] = useState<Direction | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<SendError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [priceAt, setPriceAt] = useState<string | null>(null); // the price shown when step 2 opened
  const [kick, setKick] = useState(0);
  const sending = useRef(0);
  const balance = useBalance(site.account, kick);

  const d = body.duel;
  if (!d) return null;
  const agent = target === "a" ? body.a : body.b;
  const pk = target === "a" ? d.a : d.b;
  const current: Side | null = (target === "a" ? d.last_intent_a : d.last_intent_b)?.side ?? null;
  const kind: Direction | null = pushed ?? (current ? other(current) : null);
  const fee = d.chaos_fee ?? null;
  const reason = checkHeadline(text);
  const left = MAX_HEADLINE - utf8Bytes(text);
  const typed = touched && reason ? headlineError(reason, -left) : null;
  const gate = attackGate(body, now);
  const feeBps = body.config.chaos?.fee_bps ?? 0;
  const asWritten = body.keyless?.[target === "a" ? 0 : 1]?.template === 1;
  const secondsLeft = now ? (nsMs(d.close_at) - now) / 1000 : Number.POSITIVE_INFINITY;
  const gaps = gapStats((target === "a" ? histories.a : histories.b)?.decisions.map((x) => x.at) ?? []);
  const little = secondsLeft < (gaps ? (2 * gaps.medianMs) / 1000 : 2 * body.config.intent_lock_s);
  const owns = !!site.account && (body.a?.owner === site.account || body.b?.owner === site.account);
  const poor = fee !== null && balance !== null && balance < BigInt(fee) + FEES;
  const side = (which: "a" | "b") => {
    const ag = which === "a" ? body.a : body.b;
    const s = (which === "a" ? d.last_intent_a : d.last_intent_b)?.side;
    return (
      <>
        {which.toUpperCase()} <span className="mono">{ag?.model_id ?? "?"}</span>
        {s ? ` · betting ${bet(s)}` : " · no decision yet"}
      </>
    );
  };

  const landed = (m: Mine | null) => {
    site.announce("Your headline is planted.");
    setText("");
    setTouched(false);
    setStep("write");
    setError(null);
    onPlanted(m);
  };

  async function pay() {
    if (!site.account) {
      await site.signIn(); // then back here, with nothing lost: the visitor presses the pay button
      return;
    }
    if (!fee || !kind) return;
    const run = ++sending.current;
    setError(null);
    setSlow(false);
    setBusy(site.kind === "wallet" ? "Waiting for your wallet…" : "Planting…");
    onLock(true);
    const slowTimer = setTimeout(() => sending.current === run && setSlow(true), 10_000);
    let gaveUp = false;
    const lostTimer = setTimeout(() => {
      if (sending.current !== run) return;
      gaveUp = true; // the send may still land: `landed` below handles a late success
      setBusy(null);
      onLock(false);
      setError({ kind: "lost" });
    }, 60_000);
    try {
      const call = await chaosDeploy17.prepare(
        { duel_id: d?.id ?? "", target: pk, text, kind },
        { contract: body.contract, min_chaos_deposit: body.config.min_chaos_deposit, chaos_fee: fee },
      );
      const { hash, value } = await wallet.sendFor(call);
      landed({ tx: hash, duel: d?.id ?? "", arena, at: Date.now(), index: typeof value === "number" ? value : null });
    } catch (e) {
      if (gaveUp) return;
      const msg = String(e instanceof Error ? e.message : e);
      const refused = msg.match(/the contract refused it \((.+)\) · tx/)?.[1];
      if (refused) {
        if (refused.includes("duel closed")) setError({ kind: "ended" });
        else if (refused.includes("chaos deposit too small")) {
          refresh();
          setError({ kind: "refused", reason: refused });
        } else if (/^headline |chaos full|paused/.test(refused)) {
          setFieldError(headlineError(refused));
          setStep("write");
        } else setError({ kind: "refused", reason: refused });
      } else if (/NotEnoughBalance|LackBalance|not enough/i.test(msg)) {
        setKick((k) => k + 1);
        setError({ kind: "balance" });
      } else if (/reject|cancel|denied|closed|abort|declin/i.test(msg)) setError({ kind: "cancelled" });
      else setError({ kind: "lost" });
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(lostTimer);
      if (sending.current === run && !gaveUp) {
        setBusy(null);
        setSlow(false);
        onLock(false);
      }
    }
  }

  /** After a lost connection: is the headline on chain after all? */
  async function check() {
    setBusy("Checking…");
    try {
      const fresh = await getJson<DuelBody>(duelUrl(d?.id ?? "", arena));
      const found = fresh.duel?.chaos?.some((c) => c.injector === site.account && c.headline === text);
      if (found) landed(null);
      else setError({ kind: "nothing" });
    } catch {
      setError({ kind: "lost" });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (step === "write")
    return (
      <div className="stack attack-box">
        <Segmented
          label="Plant a headline at"
          value={target}
          onChange={onTarget}
          disabled={!!gate}
          options={[
            { value: "a", label: side("a") },
            { value: "b", label: side("b") },
          ]}
        />
        <Field
          label="Your fake headline"
          face="serif"
          multiline={3}
          placeholder="Write a headline it might believe"
          value={text}
          disabled={!!gate}
          onChange={(e) => {
            setText(e.target.value);
            setTouched(true);
            setFieldError(null);
          }}
          error={typed ?? fieldError}
          count={{ text: `${left} left`, over: left < 0 }}
        />
        {current && kind ? (
          <div className="stack-2">
            <Segmented
              label="It should push the AI to bet"
              value={kind}
              onChange={setPushed}
              disabled={!!gate}
              options={[
                { value: other(current), label: bet(other(current)) },
                { value: current, label: bet(current) },
              ]}
            />
            {kind === current ? (
              <p className="t-small caution">
                {`It is already betting ${bet(current)}. This attack would not count, and you would get your money back less the fee.`}
              </p>
            ) : (
              <p className="t-small dim">
                {`It is betting ${bet(current)} now, so ${bet(other(current))} is the only push that can count.`}
              </p>
            )}
          </div>
        ) : (
          <p className="t-small dim">Wait for its first decision. An attack needs a position to push against.</p>
        )}
        <Button
          variant="primary"
          disabled={!!gate || !!reason || !current || !fee}
          why={
            gate?.why || (!fee && !gate ? "Still reading the price for this duel. Try again in a few seconds." : null)
          }
          onClick={() => {
            refresh();
            setPriceAt(fee);
            setError(null);
            setStep("confirm");
          }}
        >
          {gate?.label || (fee ? `Continue · ${near(fee)}` : "Reading price…")}
        </Button>
      </div>
    );

  return (
    <div className="stack attack-box">
      <button type="button" className="btn-link" disabled={!!busy} onClick={() => setStep("write")}>
        ← Edit
      </button>
      <Headline text={text} />
      <p>
        at {target.toUpperCase()} <span className="mono">{agent?.model_id ?? "?"}</span>
        {kind ? ` · pushing it to bet ${bet(kind)}` : ""}
      </p>
      <div>
        <div className="hrow">
          <span className="t-label">Cost</span>
          <span className="end mono">{fee ? near(fee) : "—"}</span>
        </div>
        {NETWORK_ID === "testnet" ? <p className="t-small dim">{TEST_NOTE}</p> : null}
      </div>
      <div className="stack-2">
        <h3 className="t-label">If it works</h3>
        <p>It falls for it and loses the duel: you get your money back plus a share of its bond.</p>
        <h3 className="t-label">If it does not</h3>
        <p>{`It holds: you lose your ${fee ? near(fee) : "money"}.`}</p>
        <Details label="Every possible outcome">
          <p>{`Fooled, and it loses the duel: your money back less a ${feeBps / 100}% fee, plus a share of its bond.`}</p>
          <p>Fooled, but it does not lose: your money back less the fee.</p>
          <p>{`It holds: you lose your ${fee ? near(fee) : "money"}.`}</p>
          <p>It never decides again, or your attack does not count: your money back less the fee.</p>
        </Details>
      </div>
      <p className="t-small dim">
        {asWritten
          ? "The contract flips a coin and records it. This agent reads every headline as written, so the flip does not change what it sees. Your headline is public and stays on the chain."
          : "The contract flips a coin: the AI sees your headline as written, or with its credibility cues removed. You cannot choose. Your headline is public and stays on the chain."}
      </p>
      {owns ? (
        <StatusBar kind="info">
          You own an agent in this duel. Your headline will be recorded, but it cannot pay out and the cost is not
          returned.
        </StatusBar>
      ) : null}
      {little ? (
        <p className="t-small caution">
          Little time left. If it does not decide again before the duel ends, you get your money back less the fee.
        </p>
      ) : null}
      {fee && priceAt && BigInt(fee) > BigInt(priceAt) ? (
        <p className="t-small caution">{`The price went up to ${near(fee).replace(" NEAR", "")} because someone else attacked first.`}</p>
      ) : null}
      {poor || error?.kind === "balance" ? (
        <StatusBar kind="error">
          {balance !== null && fee
            ? `You have ${near(balance)}. This costs ${near(fee).replace(" NEAR", "")} plus a little for network fees.`
            : "This account does not hold enough for the cost plus a little for network fees."}
        </StatusBar>
      ) : null}
      {error?.kind === "cancelled" ? (
        <StatusBar kind="error">You cancelled. Nothing was sent and nothing was charged.</StatusBar>
      ) : null}
      {error?.kind === "refused" ? (
        <StatusBar kind="error">
          {error.reason.includes("chaos deposit too small")
            ? headlineError(error.reason)
            : `The arena refused this headline: ${error.reason}. Nothing was charged except a small network fee.`}
        </StatusBar>
      ) : null}
      {error?.kind === "ended" ? (
        <div className="stack-2">
          <StatusBar kind="error">
            This duel ended before your headline landed. Nothing was charged except a small network fee.
          </StatusBar>
          <LinkButton variant="quiet" href="/arena">
            See a running duel
          </LinkButton>
        </div>
      ) : null}
      {error?.kind === "lost" ? (
        <StatusBar kind="error" action={{ label: "Check what happened", run: check }}>
          We lost contact while sending. Do not pay again yet.
        </StatusBar>
      ) : null}
      {error?.kind === "nothing" ? <StatusBar kind="info">Nothing was sent.</StatusBar> : null}
      <Button
        variant="attack"
        busy={busy}
        disabled={!!gate || !fee || error?.kind === "ended" || error?.kind === "lost" || (!!site.account && poor)}
        why={gate?.why}
        onClick={pay}
      >
        {gate?.label ||
          (!site.account ? "Sign in to plant it" : fee ? `Pay ${near(fee)} and plant it` : "Reading price…")}
      </Button>
      {slow ? <p className="btn-why">Still sending. This can take up to a minute when the chain is busy.</p> : null}
    </div>
  );
}
