"use client";
// One side drawer for the details behind a row: a verified decision (with a re-check that runs in the
// reader's browser against the chain, not against this server), a paid attack and the reply it got, or how
// following works. Any component under <DrawerProvider> opens it with useDrawer().
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Decision } from "../api/dataset";
import type { ArenaEvent } from "../api/tape";
import { SHOWN_WORD, shown } from "../lib/verdict";
import {
  ARENA_ID,
  account,
  clock,
  modelName,
  promptName,
  stake,
  TAMPER_TX,
  tone,
  txUrl,
  who,
  yoctoNear,
} from "./format";

type Intent = Extract<ArenaEvent, { kind: "intent" | "reveal" }>;
type Attack = Extract<ArenaEvent, { kind: "attack" }>;
export type DrawerItem =
  | { kind: "intent"; ev: Intent; model: string; d?: Decision | undefined }
  | { kind: "attack"; ev: Attack; model: string; reply?: { ev: Intent; d?: Decision | undefined } | undefined }
  | { kind: "follow"; model: string; agent: string; owner: string; prompt: string | null };

const Ctx = createContext<(i: DrawerItem) => void>(() => {});
export const useDrawer = () => useContext(Ctx);

const FASTNEAR = "https://tx.test.fastnear.com/v0/transactions";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const b64hex = (b: string) => [...atob(b)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

type Check = { label: string; ok: boolean | null; detail: string };

/** Re-hash the published bytes in this browser and compare with the hashes in the transaction itself, and
 *  check that transaction is the arena's post_intent/reveal_intent for the call shown, read from FastNEAR. */
async function recheck(ev: Intent): Promise<Check[]> {
  const tx = ev.tx;
  const out: Check[] = [];
  const pub = await fetch(`/api/v1/decisions/${tx}`).then((r) => (r.ok ? r.json() : null));
  if (!pub) return [{ label: "Published bytes", ok: null, detail: "not in the published dataset yet" }];
  const [reqHash, resHash] = await Promise.all([sha256(pub.request), sha256(pub.response)]);
  const t = await fetch(FASTNEAR, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_hashes: [tx] }),
  }).then((r) => r.json());
  const txd = t.transactions?.[0];
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
    ok: outcomes.length > 0 && !failed,
    detail: failed
      ? `refused on chain${why ? `: ${why}` : ""} (read from tx.test.fastnear.com)`
      : "read from tx.test.fastnear.com, not from this site",
  });
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
            setChecks([{ label: "Re-check failed", ok: false, detail: String(e).slice(0, 120) }]);
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
          <a href={txUrl(TAMPER_TX)} target="_blank" rel="noreferrer">
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
            {reply.d && shown(reply.d) ? (
              <p className={`vword ${shown(reply.d)}`}>{SHOWN_WORD[shown(reply.d) ?? "untested"]}.</p>
            ) : null}
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
  return (
    <div className={tone(item.model)}>
      <h3>Follow without handing over funds</h3>
      <p className="big">
        Follow <span className="who">{who(item.model)}</span> ({promptName(item.prompt)})
      </p>
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
      <p className="meta">
        Testnet today. A wallet button is not built yet; the calls above work from near-cli. Owner {item.owner}.
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
