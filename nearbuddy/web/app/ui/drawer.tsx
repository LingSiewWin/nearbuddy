"use client";
// One side drawer for the details behind a row: a verified decision (with a re-check that runs in the
// reader's browser against the chain, not against this server), a paid attack and the reply it got, or how
// following works. Any component under <DrawerProvider> opens it with useDrawer().
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import { depositFor, followArgs, nearUsd, priceFloor, SCOPE, STORAGE_NEAR } from "../lib/follow";
import { shown, shownWord } from "../lib/verdict";
import { NET } from "../network";
import { Cmd } from "./cmd";
import {
  ARENA_ID,
  account,
  CHAIN,
  clock,
  modelName,
  NETWORK_ID,
  promptName,
  stake,
  TAMPER_TX,
  tone,
  txUrl,
  who,
  YOU,
  yoctoNear,
} from "./format";

type Intent = Extract<ArenaEvent, { kind: "intent" | "reveal" }>;
type Attack = Extract<ArenaEvent, { kind: "attack" }>;
export type DrawerItem =
  | { kind: "intent"; ev: Intent; model: string; d?: Decision | undefined }
  | { kind: "attack"; ev: Attack; model: string; reply?: { ev: Intent; d?: Decision | undefined } | undefined }
  | {
      kind: "follow";
      model: string;
      agent: string;
      owner: string;
      prompt: string | null;
      /** lies that tested it and how many it took the side of, so the drawer can warn before a follow */
      lies?: { took: number; faced: number } | undefined;
    };

const Ctx = createContext<(i: DrawerItem) => void>(() => {});
export const useDrawer = () => useContext(Ctx);

const FASTNEAR = `${NET.txApi}/transactions`; // the reader's browser asks FastNEAR directly, not this site
const TX_HOST = new URL(NET.txApi).host;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const b64hex = (b: string) => [...atob(b)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

type Check = { label: string; ok: boolean | null; detail: string };

/** Re-hash the published bytes in this browser and compare with the hashes in the transaction itself, and
 *  check that transaction is the arena's post_intent/reveal_intent for the call shown, read from FastNEAR. */
async function recheck(ev: Intent): Promise<Check[]> {
  const tx = ev.tx;
  const out: Check[] = [];
  // the chain checks need only FastNEAR; the byte checks also need the published request and response
  const [pub, t] = await Promise.all([
    fetch(`/api/v1/decisions/${tx}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<{
      request: string;
      response: string;
    } | null>,
    fetch(FASTNEAR, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hashes: [tx] }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  const txd = t?.transactions?.[0];
  // FastNEAR busy (429) or a fresh call not indexed yet: say so, never "mismatch" on a valid proof
  if (!txd)
    return [
      {
        label: "The transaction on NEAR",
        ok: null,
        detail: `not readable from ${TX_HOST} yet (busy, or this call is seconds old); try again in a moment`,
      },
    ];
  const fc = txd?.transaction?.actions?.find((a: { FunctionCall?: unknown }) => a.FunctionCall)?.FunctionCall;
  const args = fc ? JSON.parse(atob(fc.args)) : null;
  // the call shown must be what the transaction carries: right contract, right method, same side and duel
  const intent = args?.signed?.intent ?? args?.intent ?? null;
  const sameCall =
    txd?.transaction?.receiver_id === ARENA_ID &&
    ["post_intent", "reveal_intent"].includes(fc?.method_name) &&
    !!intent &&
    intent.side === ev.side &&
    String(intent.duel_id) === String(ev.duel);
  out.push({
    label: "It is the arena's call shown here",
    ok: sameCall,
    detail: sameCall
      ? `${fc.method_name} on ${ARENA_ID}: ${intent.side} in duel ${intent.duel_id}`
      : `the transaction does not carry this call (${txd?.transaction?.receiver_id ?? "?"}, ${fc?.method_name ?? "?"})`,
  });
  // A transaction's own status only says its first receipt was created; a contract panic (the tampered
  // proof "bad tee signature") lives in a receipt outcome, so every receipt in the tree must have succeeded.
  type Outcome = { status?: Record<string, unknown> };
  const outcomes: Outcome[] = [
    txd?.execution_outcome?.outcome,
    ...(txd?.receipts ?? []).map((r: { execution_outcome?: { outcome?: Outcome } }) => r.execution_outcome?.outcome),
  ].filter(Boolean);
  const failed = outcomes.find((o) => o.status && "Failure" in o.status);
  const why = failed ? JSON.stringify(failed.status).match(/panicked: ([^"\\]+)/)?.[1] : null;
  out.push({
    label: failed ? "The contract refused this transaction" : "Every receipt succeeded on NEAR",
    ok: failed ? false : outcomes.length > 0 ? true : null, // no outcomes read: no verdict
    detail: failed
      ? `refused on chain${why ? `: ${why}` : ""} (read from ${TX_HOST})`
      : `read from ${TX_HOST}, not from this site`,
  });
  if (!pub) {
    out.push({
      label: "The model's request and response bytes",
      ok: null,
      detail: "not published yet (the dataset is exported in batches); the chain checks above stand on their own",
    });
    return out;
  }
  const [reqHash, resHash] = await Promise.all([sha256(pub.request), sha256(pub.response)]);
  out.push({
    label: "Request bytes hash to the chain's request_hash",
    ok: !!args?.tee && b64hex(args.tee.request_hash) === reqHash,
    detail: `sha256 ${reqHash.slice(0, 16)}…`,
  });
  out.push({
    label: "Response bytes hash to the chain's response_hash",
    ok: !!args?.tee && b64hex(args.tee.response_hash) === resHash,
    detail: `sha256 ${resHash.slice(0, 16)}…`,
  });
  return out;
}

function Recheck({ ev }: { ev: Intent }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="recheck">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setChecks(await recheck(ev));
          } catch (e) {
            // the check could not run (network, decoding): that is no verdict, so never a red "Mismatch"
            setChecks([{ label: "The re-check could not run", ok: null, detail: String(e).slice(0, 120) }]);
          }
          setBusy(false);
        }}
      >
        {busy ? "Checking…" : "Re-check it in my browser"}
      </button>
      {checks ? (
        <ul className="rc">
          {checks.map((c) => (
            <li key={c.label} className={c.ok === true ? "ok" : c.ok === false ? "bad" : "na"}>
              <b>{c.ok === true ? "Match" : c.ok === false ? "Mismatch" : "Not available"}</b> {c.label}
              <small>{c.detail}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Seal() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0l2 1.6 2.5-.2.8 2.4 2.1 1.4-.8 2.4.8 2.4-2.1 1.4-.8 2.4-2.5-.2L8 16l-2-1.6-2.5.2-.8-2.4L.6 10.8l.8-2.4-.8-2.4 2.1-1.4.8-2.4 2.5.2z"
      />
      <path fill="var(--bg)" d="M7 10.6L4.6 8.2l1-1 1.4 1.4 3.4-3.4 1 1z" />
    </svg>
  );
}

export { Seal };

function Body({ item }: { item: DrawerItem }) {
  if (item.kind === "intent" && !(item.ev.ok && item.ev.tee === 2)) {
    // a refused call, or one without an enclave proof, never gets the verified body
    const { ev, model } = item;
    return (
      <div className={tone(model)}>
        <h3>{ev.ok ? "Call without an enclave proof" : "Call refused on chain"}</h3>
        <p className="big">
          <span className="who">{who(model)}</span> {ev.ok ? "posted" : "tried to post"} {ev.side} with{" "}
          {stake(ev.size / 100)}
        </p>
        <p className="meta">
          Duel #{ev.duel} · {clock(ev.at).join("")} ·{" "}
          <a href={txUrl(ev.tx)} target="_blank" rel="noreferrer">
            the transaction ↗
          </a>
        </p>
        <p className="cap">
          {ev.ok
            ? "This agent is in the unverified tier: its call counts on the board, but nothing proves a model inside an enclave made it, and it cannot be followed."
            : "The contract rejected this transaction, so the call does not count. Common reasons: the duel's last minute (calls are locked), a stale nonce, or a proof that does not verify."}
        </p>
      </div>
    );
  }
  if (item.kind === "intent") {
    const { ev, d, model } = item;
    return (
      <div className={tone(model)}>
        <h3>
          <Seal /> Verified decision
        </h3>
        <p className="big">
          <span className="who">{who(model)}</span> went {ev.side === "Long" ? "Long (up)" : "Short (down)"} with{" "}
          {stake(ev.size / 100)}
        </p>
        <p className="meta">
          Duel #{ev.duel} · {clock(ev.at).join("")} · {modelName(model)}
          {d ? ` · ${promptName(d.arm)}` : ""}
        </p>
        {d?.reason ? <blockquote className="dwhy">“{d.reason}”</blockquote> : null}
        <ol className="checks">
          <li>
            <b>Decided inside a NEAR AI enclave</b>
            The enclave signed the exact request and response bytes; nobody outside it could have written this answer.
          </li>
          <li>
            <b>Checked by the contract before it counted</b>
            post_intent verified the enclave&apos;s signature against the signer pinned from the model&apos;s
            attestation.{" "}
            <a href={txUrl(ev.tx)} target="_blank" rel="noreferrer">
              See the transaction ↗
            </a>
          </li>
          <li>
            <b>You can re-check it</b>
            Your browser hashes the published bytes and compares them with the hashes inside the transaction.
          </li>
        </ol>
        <Recheck ev={ev} />
        <div className="tamper">
          <b>Tampering is refused.</b> A real proof with one flipped byte was rejected on chain:{" "}
          <a href={txUrl(TAMPER_TX, "testnet")} target="_blank" rel="noreferrer">
            bad tee signature ↗
          </a>
        </div>
      </div>
    );
  }
  if (item.kind === "attack") {
    const { ev, reply, model } = item;
    return (
      <div className={tone(model)}>
        <h3>Paid attack</h3>
        <p className="big">
          {account(ev.signer)} paid {yoctoNear(ev.paid)} NEAR to feed <span className="who">{who(model)}</span> this:
        </p>
        <div className="lie">{ev.text ? `“${ev.text}”` : "A custom headline; only its hash is on chain."}</div>
        <p className="meta">
          Duel #{ev.duel} · {clock(ev.at).join("")} ·{" "}
          <a href={txUrl(ev.tx)} target="_blank" rel="noreferrer">
            inject_chaos ↗
          </a>
        </p>
        {reply ? (
          <>
            <p className="cap">
              Its next decision, {Math.max(0, Math.round((reply.ev.at - ev.at) / 1000))} s later: {reply.ev.side}{" "}
              {reply.ev.size / 100}%
            </p>
            {reply.d?.reason ? <blockquote className="dwhy">“{reply.d.reason}”</blockquote> : null}
            {reply.d?.named_in && (reply.d.verdict === "named" || reply.d.verdict === "resisted") ? (
              <p className="cap">In its signed answer it {reply.d.named_in}.</p>
            ) : null}
            {reply.d && shown(reply.d) ? <p className={`vword ${shown(reply.d)}`}>{shownWord(reply.d)}.</p> : null}
          </>
        ) : (
          <p className="cap">Waiting for its next decision.</p>
        )}
        <p className="meta">
          Only the headline&apos;s sha256 goes on chain; the arena&apos;s solver hands the text to the model before its
          next call. Attacks are capped at 32 per duel and every deposit joins the winner&apos;s pot.
        </p>
      </div>
    );
  }
  return <Follow item={item} />;
}

/** How to follow an agent, with a follow command the contract accepts: deploy 15 refuses a mandate without a
 *  price floor, so the floor is 95% of NEAR's Coinbase price when the drawer opens. */
function Follow({ item }: { item: Extract<DrawerItem, { kind: "follow" }> }) {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    // no price: the command shows a placeholder and the text says how to fill it
    nearUsd().then((p) => alive && p != null && setPrice(p));
    return () => {
      alive = false;
    };
  }, []);
  const floor = price ? priceFloor(price) : null;
  return (
    <div className={tone(item.model)}>
      <h3>Follow without handing over funds</h3>
      <p className="big">
        Follow <span className="who">{who(item.model)}</span> ({promptName(item.prompt)})
      </p>
      {item.lies?.faced && item.lies.took * 2 >= item.lies.faced ? (
        <p className="warn" role="note">
          Before you follow: it took the side of {item.lies.took} of the {item.lies.faced} paid lies that went against
          the price it could see. A follower copies those calls too.
        </p>
      ) : null}
      <ol className="checks">
        <li>
          <b>Deposit into your own vault</b>
          <code>deposit</code> on the arena contract; <code>withdraw</code> takes it back any time.
        </li>
        <li>
          <b>Sign a spending limit, not a transfer</b>
          <code>follow</code> with a cap per trade, a total, the tokens it may touch and an expiry. Only
          enclave-verified agents can be followed.
        </li>
        <li>
          <b>Fills stay inside it</b>
          When the agent posts a call, the solver quotes you through NEAR Intents; the contract refuses any fill over
          the cap, in the wrong token, expired or revoked. <code>unfollow</code> stops it.
        </li>
      </ol>
      <p className="cap">With near-cli-rs, from your own account on {CHAIN} (amounts in yoctoNEAR, expiry in ns):</p>
      <Cmd
        text={`near contract call-function as-transaction ${ARENA_ID} deposit empty-args prepaid-gas '30 Tgas' attached-deposit '${depositFor(1)} NEAR' sign-as ${YOU} network-config ${NETWORK_ID} sign-with-keychain send`}
      />
      <Cmd
        text={`near contract call-function as-transaction ${ARENA_ID} follow json-args '${JSON.stringify(followArgs(item.agent, { capNear: 0.2, allowanceNear: 1, days: 7, floor, now: Date.now() }))}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${YOU} network-config ${NETWORK_ID} sign-with-keychain send`}
      />
      <p className="meta">
        That follows with a 0.2 NEAR cap per fill, 1 NEAR in total, for a week (the deposit adds {STORAGE_NEAR} NEAR for
        storage). {SCOPE}{" "}
        {price
          ? `A fill must return at least 95% of NEAR's price now ($${price.toFixed(4)} on Coinbase), so min_out_per_near is ${floor} USDC units (6 decimals) per NEAR.`
          : "Set min_out_per_near to 95% of NEAR's USD price times 1,000,000 (USDC has 6 decimals); the contract refuses a follow without a price floor."}{" "}
        No wallet button yet. Owner {item.owner}.
      </p>
    </div>
  );
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [item, setItem] = useState<DrawerItem | null>(null);
  const open = useCallback((i: DrawerItem) => setItem(i), []);
  useEffect(() => {
    if (item && !ref.current?.open) ref.current?.showModal();
  }, [item]);
  return (
    <Ctx.Provider value={open}>
      {children}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Esc is native to <dialog> */}
      <dialog
        ref={ref}
        aria-label={
          item?.kind === "intent" ? "Verified decision" : item?.kind === "attack" ? "Paid attack" : "Follow an agent"
        }
        onClose={() => setItem(null)}
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <button type="button" className="dx" onClick={() => ref.current?.close()}>
          Close
        </button>
        {item ? <Body item={item} /> : null}
      </dialog>
    </Ctx.Provider>
  );
}
