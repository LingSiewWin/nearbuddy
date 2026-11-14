"use client";
// Enter your agent: pick a model, write a strategy, lock a bond. One register_keyless call on the keyless arena,
// checked first with the contract's own rules (lib/enter.ts, lib/keyless.ts), signed by the wallet or guest account.
// The sealed-strategy checkbox is not rendered: the arena's entry call still takes the strategy as plain text.
import { useState } from "react";
import type { Pinned } from "../api/keyless";
import { DEFAULT_BOND_NEAR, enterCall, MAX_BOND_NEAR, MIN_BOND_NEAR } from "../lib/enter";
import { MAX_STRATEGY } from "../lib/keyless";
import * as wallet from "../lib/wallet";
import { NETWORK_ID } from "../network";
import { getJson } from "../tui";
import { useSite } from "../ui/chrome";
import { agentPath } from "../ui/data";
import { TEST_NOTE } from "../ui/format";
import { Button, Field, LinkButton, Region, Skeleton, StatusBar, useRead } from "../ui/kit";

type Info = { contract: string | null; models: Pinned[]; agents?: string[] };

/** Which field a refusal belongs to, and the design's copy for it. `over`: bytes past the strategy limit. */
function copyFor(reason: string, over: number): { field: "strategy" | "model" | "bond"; text: string } {
  if (reason.includes("strategy empty")) return { field: "strategy", text: "Write a strategy first." };
  if (reason.includes("strategy too long"))
    return { field: "strategy", text: `Too long by ${over}. The limit is 512 bytes.` };
  if (reason.includes("strategy"))
    return {
      field: "strategy",
      text: "Use English letters, numbers and punctuation only. Accents, emoji and line breaks are not accepted.",
    };
  if (reason.includes("model_id too long") || reason.includes("control character"))
    return { field: "model", text: "This model name is not accepted." };
  if (reason.includes("at least")) return { field: "bond", text: `At least ${MIN_BOND_NEAR} NEAR.` };
  if (reason.includes("at most")) return { field: "bond", text: `At most ${MAX_BOND_NEAR} NEAR.` };
  return { field: "bond", text: `Enter an amount like ${DEFAULT_BOND_NEAR}.` };
}

export default function Enter({ contract }: { contract: string | null }) {
  const site = useSite();
  const read = useRead<Info>(contract ? "/api/keyless" : null, 60_000, 0);
  const [model, setModel] = useState("");
  const [strategy, setStrategy] = useState("");
  const [bond, setBond] = useState(DEFAULT_BOND_NEAR);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ cancelled: boolean; reason: string } | null>(null);
  const [entered, setEntered] = useState<{ pk: string | null } | null>(null);

  if (!contract)
    return (
      <div className="page enter">
        <h1 className="t-display">Enter your agent</h1>
        <p>{`Entering an agent is not open on ${NETWORK_ID} yet.`}</p>
      </div>
    );
  const chosen = model || read.data?.models[0]?.model_id || "";
  const bytes = new TextEncoder().encode(strategy).length;
  let bad: ReturnType<typeof copyFor> | null = null;
  let call: ReturnType<typeof enterCall> | null = null;
  try {
    call = enterCall(contract, { model_id: chosen, strategy, bond_near: bond });
  } catch (e) {
    bad = copyFor(String(e instanceof Error ? e.message : e), bytes - MAX_STRATEGY);
  }
  const err = (f: "strategy" | "model" | "bond") => (touched && bad?.field === f ? bad.text : undefined);

  async function send() {
    setTouched(true);
    if (!call) return;
    let account = site.account;
    if (!account) {
      account = await site.signIn();
      if (!account) return;
    }
    setFailed(null);
    setBusy(site.kind === "wallet" ? "Waiting for your wallet…" : "Entering…");
    try {
      const { value } = await wallet.sendFor(call);
      const pk = (value as { pk?: unknown } | undefined)?.pk;
      // a wallet that hands back no return value: the newest agent this account owns
      const mine =
        typeof pk === "string"
          ? null
          : await getJson<Info>(`/api/keyless?owner=${encodeURIComponent(account)}`).catch(() => null);
      setEntered({ pk: typeof pk === "string" ? pk : (mine?.agents?.at(-1) ?? null) });
    } catch (e) {
      const reason = String(e instanceof Error ? e.message : e).slice(0, 200);
      setFailed({ cancelled: /reject|cancel|denied|closed|abort|declin/i.test(reason), reason });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page enter stack-5">
      <div className="stack-2">
        <h1 className="t-display">Enter your agent</h1>
        <p>
          Lock a bond, give it a strategy, and let people try to fool it. If it is fooled and loses, part of the bond
          pays the attacker.
        </p>
      </div>
      {entered ? (
        <div className="stack">
          <p className="t-title">Your agent is entered.</p>
          {entered.pk ? (
            <>
              <p className="t-mono">{entered.pk}</p>
              <LinkButton variant="primary" fit href={agentPath(entered.pk)}>
                Open its page
              </LinkButton>
            </>
          ) : null}
          <p className="dim">It joins the next duel that opens. This page cannot say when.</p>
        </div>
      ) : (
        <Region read={read} skeleton={<Skeleton bars={["100%", "100%", "100%", "40%"]} />}>
          {(info) =>
            info.models.length === 0 ? (
              <p>No models are open for entry right now.</p>
            ) : (
              <form
                className="stack-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) send();
                }}
              >
                <Field label="Model" help="Which model runs your agent." error={err("model")}>
                  <select value={chosen} onChange={(e) => setModel(e.target.value)} className="mono">
                    {info.models.map((m) => (
                      <option key={m.model_id} value={m.model_id}>
                        {m.model_id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Strategy"
                  face="mono"
                  multiline={5}
                  value={strategy}
                  onChange={(e) => {
                    setStrategy(e.target.value.replace(/[\r\n]+/g, " ")); // one line: pasted line breaks become spaces
                    setTouched(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  help="Plain instructions your agent follows in every decision. Up to 512 characters, on one line: English letters, numbers and punctuation only. Your strategy is public as soon as you enter."
                  count={{ text: `${MAX_STRATEGY - bytes} left`, over: bytes > MAX_STRATEGY }}
                  error={err("strategy")}
                />
                <Field
                  label="Bond"
                  face="mono"
                  inputMode="decimal"
                  value={bond}
                  onChange={(e) => {
                    setBond(e.target.value);
                    setTouched(true);
                  }}
                  suffix="NEAR"
                  help="Money you lock as a promise. Between 0.02 and 100 NEAR. A lost duel takes part of it; the rest comes back when you withdraw."
                  error={err("bond")}
                />
                <div className="stack-2">
                  <p>{`You lock ${bond.trim() || DEFAULT_BOND_NEAR} NEAR.${NETWORK_ID === "testnet" ? ` ${TEST_NOTE}.` : ""}`}</p>
                  {site.kind === "guest" ? (
                    <StatusBar kind="info">
                      This is a guest account. If you clear this browser, you lose access to the bond.
                    </StatusBar>
                  ) : null}
                  {failed ? (
                    <StatusBar
                      kind="error"
                      {...(failed.cancelled ? {} : { action: { label: "Try again", run: send } })}
                    >
                      {failed.cancelled
                        ? "You cancelled. Nothing was sent."
                        : `Could not enter. Nothing was locked. ${failed.reason}`}
                    </StatusBar>
                  ) : null}
                  <Button variant="primary" type="submit" busy={busy}>
                    {site.account ? "Lock bond and enter" : "Sign in to enter"}
                  </Button>
                </div>
              </form>
            )
          }
        </Region>
      )}
    </div>
  );
}
