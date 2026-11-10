"use client";
// The builder's three minutes, in the terminal look of /: 1 pick a model pinned on the keyless arena, 2 write a
// strategy (checked with the contract's rules as you type), 3 sign one register_keyless, 4 watch the agent: waiting
// for a duel, slot open, decided; 5 read the exact request the model gets. Data: GET /api/keyless (the pinned
// models, your agents, one agent's views, polled every 4 s while visible). Wallet: NEAR Connect (lib/wallet).
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Pinned } from "../api/keyless";
import {
  type AgentState,
  DEFAULT_BOND_NEAR,
  enterCall,
  exampleInputs,
  MIN_BOND_NEAR,
  slotInputs,
  statusLine,
} from "../lib/enter";
import { checkStrategy, KEYLESS_TEMPLATE_VERSION, keylessRequest, MAX_STRATEGY, toHex } from "../lib/keyless";
import * as wallet from "../lib/wallet";
import { Box, type Cell, Line, Note, Slot } from "../term/box";
import { getJson, NETWORK_ID, near, short, txHref } from "../tui";

type Info = { network: string; contract: string | null; models: Pinned[]; agents?: string[]; state?: AgentState };
const HINT: Record<string, string> = {
  "strategy empty": "write at least one character",
  "strategy too long": `at most ${MAX_STRATEGY} bytes`,
  "strategy character":
    "printable ASCII only: letters, digits, punctuation and spaces; no line breaks, tabs or accents",
};
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const refusalOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/** Columns of monospace text that fit the page, measured from a probe span (as term.tsx does). */
function useCols(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(100);
  useEffect(() => {
    const el = ref.current;
    const probe = el?.querySelector<HTMLElement>(".probe");
    if (!el || !probe) return;
    const ro = new ResizeObserver(() => {
      const cw = probe.getBoundingClientRect().width / 10;
      if (cw > 0) setCols(Math.floor(el.clientWidth / cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols];
}

/** A request body as the model reads it: the model, each message's text line by line, then the sampling fields. */
function RequestLines({ bytes, w }: { bytes: Uint8Array; w: number }): ReactNode {
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    model: string;
    messages: { role: string; content: string }[];
    max_tokens: number;
    temperature: number;
    seed: number;
    stream: boolean;
  };
  return (
    <>
      <Line
        w={w}
        cells={[
          { t: "model   ", c: "dim" },
          { t: body.model, c: "hi" },
        ]}
      />
      {body.messages.map((m) => (
        <div key={m.role}>
          <Line w={w} cells={[{ t: `${m.role}:`, c: "num" }]} />
          {m.content.split("\n").map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of one message, in order
            <Note key={i} w={w} text={l} c={m.role === "system" ? "dim" : "hi"} />
          ))}
        </div>
      ))}
      <Line
        w={w}
        cells={[
          {
            t: `max_tokens ${body.max_tokens} · temperature ${body.temperature} · seed ${body.seed} · stream ${body.stream}`,
            c: "dim",
          },
        ]}
      />
    </>
  );
}

export default function Enter({ contract }: { contract: string | null }) {
  const [rootRef, cols] = useCols();
  const [info, setInfo] = useState<Info | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("Trend follower: trade with the move since open; stay small when unsure.");
  const [bond, setBond] = useState(DEFAULT_BOND_NEAR);
  const [account, setAccount] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [pk, setPk] = useState<string | null>(null);
  const [st, setSt] = useState<AgentState | null>(null);
  const [stErr, setStErr] = useState<string | null>(null);
  const [draftHash, setDraftHash] = useState<string | null>(null);
  const [slotHash, setSlotHash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ t: string; c?: string | undefined } | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const say = (t: string, c?: string) => setMsg({ t, c });

  // ?agent=<key> opens one agent's status; ?owner=<account> lists an account's agents without a wallet
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setPk(q.get("agent"));
    setOwner(q.get("owner"));
  }, []);
  // the wallet a previous visit connected, and sign-ins/outs from the wallet's own UI
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    wallet.account().then((a) => alive && setAccount(a));
    wallet
      .onChange((a) => alive && setAccount(a))
      .then((f) => {
        off = f;
        if (!alive) f();
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  // the pinned models and the agents of the connected (or ?owner=) account
  const who = account ?? owner;
  useEffect(() => {
    let alive = true;
    getJson<Info>(`/api/keyless${who ? `?owner=${encodeURIComponent(who)}` : ""}`)
      .then((j) => {
        if (!alive) return;
        setInfo(j);
        setInfoErr(null);
        setModel((m) => m ?? j.models[0]?.model_id ?? null);
      })
      .catch((e) => alive && setInfoErr(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [who]);
  // one agent's views, every 4 s while the tab is visible
  useEffect(() => {
    if (!pk) return;
    let alive = true;
    const go = () => {
      if (document.visibilityState === "hidden") return;
      getJson<Info>(`/api/keyless?agent=${encodeURIComponent(pk)}`)
        .then((j) => {
          if (!alive) return;
          setSt(j.state ?? null);
          setStErr(null);
        })
        .catch((e) => alive && setStErr(String(e instanceof Error ? e.message : e)));
    };
    go();
    const t = setInterval(go, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pk]);

  // the draft's request (placeholder slot inputs) and, for the agent shown, its open slot's request from the views
  const refusal = refusalOf(() => checkStrategy(strategy));
  let draft: Uint8Array | null = null;
  let draftErr: string | null = null;
  try {
    if (model) draft = keylessRequest(exampleInputs(model, strategy));
  } catch (e) {
    draftErr = e instanceof Error ? e.message : String(e);
  }
  let slotReq: Uint8Array | null = null;
  let slotErr: string | null = null;
  if (st?.agent && st.keyless && st.duel && st.slot && st.agent.in_duel === st.duel.id)
    try {
      slotReq = keylessRequest(slotInputs(st.agent, st.keyless, st.duel, st.slot, st.chaos));
    } catch (e) {
      slotErr = e instanceof Error ? e.message : String(e);
    }
  // hashed from the decoded text (exact: the body is UTF-8 JSON), so the effects re-run only when the bytes change
  const draftBody = draft ? new TextDecoder().decode(draft) : "";
  const slotBody = slotReq ? new TextDecoder().decode(slotReq) : "";
  useEffect(() => {
    let alive = true;
    setDraftHash(null);
    if (draftBody) sha256(new TextEncoder().encode(draftBody)).then((h) => alive && setDraftHash(toHex(h)));
    return () => {
      alive = false;
    };
  }, [draftBody]);
  useEffect(() => {
    let alive = true;
    setSlotHash(null);
    if (slotBody) sha256(new TextEncoder().encode(slotBody)).then((h) => alive && setSlotHash(b64(h)));
    return () => {
      alive = false;
    };
  }, [slotBody]);

  const select = (p: string) => {
    setPk(p);
    setSt(null);
    const u = new URL(location.href);
    u.searchParams.set("agent", p);
    history.replaceState(null, "", u);
  };

  async function connect() {
    if (account) {
      await wallet.signOut().catch(() => {});
      setAccount(null);
      return say("disconnected");
    }
    try {
      say("pick a wallet");
      const a = await wallet.signIn();
      setAccount(a);
      say(a ? `connected as ${a}` : "no account selected", a ? "ok" : "warn");
    } catch (e) {
      say(`wallet: ${e instanceof Error ? e.message : e}`, "bad");
    }
  }

  async function sign() {
    if (busy) return;
    if (!contract) return say(`no keyless arena on ${NETWORK_ID} yet`, "bad");
    if (!model) return say("pick a model first", "warn");
    let call: ReturnType<typeof enterCall>;
    try {
      call = enterCall(contract, { model_id: model, strategy, bond_near: bond });
    } catch (e) {
      return say(`the contract would refuse this: ${e instanceof Error ? e.message : e} · nothing was signed`, "warn");
    }
    let me = account;
    if (!me) {
      say("connect a wallet to sign");
      me = await wallet.signIn().catch(() => null);
      setAccount(me);
      if (!me) return say("no account selected: nothing was signed", "warn");
    }
    const owned = () => getJson<Info>(`/api/keyless?owner=${encodeURIComponent(me)}`).catch(() => null);
    setBusy(`sign in your wallet: register_keyless with ${near(call.deposit)} NEAR to ${call.receiverId}`);
    try {
      const before = new Set((await owned())?.agents ?? []); // the new agent is the one this list lacks
      const hash = await wallet.send(call); // throws when the wallet declines or the contract refuses
      setTx(hash);
      setBusy(`registered (tx ${short(hash, 10)}); reading your agent's id`);
      for (let i = 0; i < 20; i++) {
        const j = await owned();
        const fresh = j?.agents?.find((p) => !before.has(p));
        if (j && fresh) {
          setInfo(j);
          select(fresh);
          return say(`your agent ${short(fresh, 12)} is entered: tx ${short(hash, 10)}`, "ok");
        }
        await sleep(2000);
      }
      say(`tx ${short(hash, 10)} landed; your agent shows in box 4 shortly`, "ok");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  const two = cols >= 122;
  const P = Math.max(36, Math.min(two ? Math.floor((cols - 2) / 2) : cols, 100));
  const W = P - 4;
  const models = info?.models ?? [];
  const bytes = new TextEncoder().encode(strategy).length;
  const callErr =
    contract && model ? refusalOf(() => enterCall(contract, { model_id: model, strategy, bond_near: bond })) : null;
  const status = st ? statusLine(st, BigInt(Date.now()) * 1_000_000n) : null;

  const modelBox = (
    <Box n={1} title="model" extra={contract ? `pinned on ${contract}` : "no keyless arena"} w={P} on id="enter-model">
      {models.length ? (
        models.map((m) => (
          <Line
            key={m.model_id}
            w={P}
            sel={model === m.model_id}
            onClick={() => setModel(m.model_id)}
            label={`model ${m.model_id}${model === m.model_id ? ", selected" : ""}`}
            cells={[
              { t: `[${model === m.model_id ? "x" : " "}] `, c: model === m.model_id ? "hi" : "dim" },
              { t: m.model_id.padEnd(Math.min(40, W - 24)), c: model === m.model_id ? "hi" : undefined },
              {
                t: ` enclave key ${short(toHex(Uint8Array.from(atob(m.signer), (c) => c.charCodeAt(0))), 8)}`,
                c: "dim",
              },
            ]}
          />
        ))
      ) : (
        <Note
          w={P}
          text={
            !contract
              ? `keyless agents are not on NEAR ${NETWORK_ID} yet`
              : infoErr
                ? `could not read the pinned models: ${infoErr}`
                : "reading the models pinned on the contract"
          }
          c={infoErr ? "bad" : "dim"}
        />
      )}
      <Note
        w={P}
        text="Each model is pinned to one NEAR AI Cloud enclave key. The contract accepts a decision only with that key's signature over its own request and the reply."
      />
    </Box>
  );

  const strategyBox = (
    <Box n={2} title="strategy" extra="the last line of its system prompt" w={P} on id="enter-strategy">
      <Slot rows={4}>
        <textarea
          className="headline"
          aria-label="strategy"
          aria-invalid={!!refusal}
          aria-describedby="strategy-check"
          rows={4}
          value={strategy}
          style={{ width: `${W}ch` }}
          spellCheck={false}
          onChange={(e) => setStrategy(e.target.value)}
        />
      </Slot>
      <div id="strategy-check">
        <Line
          w={P}
          cells={[
            { t: `${bytes}/${MAX_STRATEGY} bytes`, c: bytes > MAX_STRATEGY ? "bad" : "dim" },
            { t: " · printable ASCII, 1 to 512 bytes (the contract's check_strategy)", c: "dim" },
          ]}
        />
        {refusal ? (
          <Note w={P} text={`the contract would refuse this: ${refusal}. ${HINT[refusal] ?? ""}`} c="bad" />
        ) : (
          <Line w={P} cells={[{ t: "ok: the contract accepts this strategy", c: "ok" }]} />
        )}
      </div>
    </Box>
  );

  const requestBox = (
    <Box n={5} title="request" extra="exactly what the model will read" w={P} on id="enter-request">
      <Note
        w={P}
        text="Template 1, built by the contract from chain state at each slot. Price, open price, seconds left, duel, slot and nonce below are placeholders until a keeper opens a slot; paid headlines arrive as extra unverified blocks."
      />
      {draft ? (
        <RequestLines bytes={draft} w={P} />
      ) : (
        <Note w={P} text={draftErr ? `not buildable: ${draftErr}` : "pick a model"} c={draftErr ? "bad" : "dim"} />
      )}
      {draft ? (
        <Line
          w={P}
          cells={[
            { t: `${draft.length} bytes · sha256 `, c: "dim" },
            { t: draftHash ?? "…", c: "hi" },
          ]}
        />
      ) : null}
    </Box>
  );

  const signBox = (
    <Box n={3} title="enter" extra="one transaction, no agent key" w={P} on id="enter-sign">
      <Slot rows={1}>
        <span className="row" style={{ width: `${W}ch`, display: "flex" }}>
          <label htmlFor="enter-bond" className="dim">
            {"bond   "}
          </label>
          <input
            id="enter-bond"
            className="headline"
            inputMode="decimal"
            value={bond}
            style={{ width: "10ch" }}
            onChange={(e) => setBond(e.target.value)}
          />
          <span className="dim">
            {` NEAR · at least ${MIN_BOND_NEAR}; storage (≤0.011) comes out of it`.slice(0, Math.max(0, W - 17))}
          </span>
        </span>
      </Slot>
      <Line
        w={P}
        cells={[
          { t: "call   ", c: "dim" },
          { t: "register_keyless", c: "hi" },
          { t: ` → ${contract ?? "-"} · 30 TGas`, c: "dim" },
        ]}
      />
      <Note
        w={P}
        text={`args   ${JSON.stringify({ model_id: model, strategy, template_version: KEYLESS_TEMPLATE_VERSION })}`}
      />
      {callErr ? <Note w={P} text={`the contract would refuse this: ${callErr}`} c="bad" /> : null}
      <Line
        w={P}
        cells={[
          account
            ? { t: `[${account.slice(0, 24)}]`, c: "ok", onClick: connect, label: "disconnect wallet" }
            : { t: "[connect wallet]", onClick: connect, title: `a NEAR ${NETWORK_ID} wallet` },
          "  ",
          {
            t: "[sign register_keyless]",
            c: callErr || busy ? "dim" : "warn",
            onClick: sign,
            label: "sign register_keyless with your wallet",
          },
          tx ? { t: `  tx ${short(tx, 10)}`, href: txHref(tx), c: "dim" } : "",
        ]}
      />
    </Box>
  );

  const agents = info?.agents ?? [];
  const a = st?.agent;
  const kv = (k: string, v: Cell[]) => <Line w={P} cells={[{ t: k.padEnd(9), c: "dim" }, ...v]} />;
  const agentBox = (
    <Box n={4} title="your agent" extra="live from the contract" w={P} on id="enter-agent">
      {who ? (
        <Line
          w={P}
          cells={[
            { t: `${who}: `, c: "dim" },
            ...(agents.length
              ? agents.flatMap((p): Cell[] => [
                  {
                    t: `[${p === pk ? "x" : " "}] ${p.slice(0, 8)}`,
                    c: p === pk ? "hi" : "dim",
                    onClick: () => select(p),
                    label: `agent ${p}`,
                  },
                  " ",
                ])
              : [{ t: info ? "no keyless agent yet" : "reading", c: "dim" }]),
          ]}
        />
      ) : null}
      {!pk ? (
        <Note w={P} text="Your agent shows here once the transaction lands, or open /enter?agent=<its base64 key>." />
      ) : !st ? (
        <Note w={P} text={stErr ? `could not read ${pk}: ${stErr}` : `reading ${pk}`} c={stErr ? "bad" : "dim"} />
      ) : (
        <>
          {kv("id", [{ t: pk, c: "hi" }])}
          {a ? kv("owner", [a.owner]) : null}
          {a ? kv("model", [a.model_id]) : null}
          {a ? kv("bond", [`${near(a.bond)} NEAR · alpha ${a.alpha_bps} bps · shield ${a.shield}`]) : null}
          {st.keyless ? kv("strategy", [{ t: st.keyless.strategy, title: st.keyless.strategy }]) : null}
          {status ? <div data-testid="agent-status">{kv("status", [{ t: status.t, c: status.c }])}</div> : null}
          {kv(
            "duels",
            st.duels.length
              ? st.duels.flatMap((d): Cell[] => [
                  {
                    t: `#${d} verify`,
                    href: `/api/keyless/verify?duel=${d}`,
                    title: `check duel #${d} from public sources`,
                  },
                  " ",
                ])
              : [{ t: "none yet: the arena's owner pairs agents into duels", c: "dim" }],
          )}
          {slotReq && st.slot ? (
            <>
              <Line
                w={P}
                cells={[{ t: `request of slot ${st.slot.seq}, rebuilt here from the contract's views:`, c: "num" }]}
              />
              <RequestLines bytes={slotReq} w={P} />
              <div data-testid="slot-hash">
                <Line
                  w={P}
                  cells={[
                    { t: `${slotReq.length} bytes · sha256 `, c: "dim" },
                    { t: slotHash ? toHex(Uint8Array.from(atob(slotHash), (c) => c.charCodeAt(0))) : "…", c: "hi" },
                  ]}
                />
                <Line
                  w={P}
                  cells={
                    slotHash === null
                      ? [{ t: "hashing", c: "dim" }]
                      : slotHash === st.slot.request_hash
                        ? [{ t: `= request_hash the contract stored for slot ${st.slot.seq}: nothing hidden`, c: "ok" }]
                        : [{ t: `≠ request_hash on chain (${st.slot.request_hash}): do not trust this page`, c: "bad" }]
                  }
                />
              </div>
            </>
          ) : slotErr ? (
            <Note w={P} text={`could not rebuild the slot's request: ${slotErr}`} c="bad" />
          ) : null}
          <Note
            w={P}
            text="Anyone can keep it: a keeper reads keyless_request, posts those bytes to NEAR AI Cloud and submits the enclave-signed reply (bun run keeper in packages/keeper). It pays gas and the model fee, never holds a key of yours."
          />
        </>
      )}
    </Box>
  );

  return (
    <div className="term" ref={rootRef}>
      <span className="probe" aria-hidden="true">
        0000000000
      </span>
      <header className="bar">
        <span>{` NEAR ${NETWORK_ID} `}</span>
        <span aria-hidden="true">│</span>
        <span>{" enter an agent "}</span>
        <span aria-hidden="true">│</span>
        <button type="button" className="barbtn" onClick={connect}>
          {account ? ` ${account} ` : " connect wallet "}
        </button>
        <span className="grow" />
        <a className="barbtn" href="/" style={{ color: "inherit" }}>
          {" fool the AI "}
        </a>
      </header>
      <h1 className="intro">
        <span className="hi">enter your AI agent</span>
        <span className="dim">
          {" "}
          · pick a model, write its strategy, sign one transaction. No key and nothing to install: the contract writes
          the prompt, a NEAR AI Cloud enclave signs the answer, the contract reads the decision.
        </span>
      </h1>
      <main className="grid">
        {two ? (
          <>
            <div className="col">
              {modelBox}
              {strategyBox}
              {signBox}
              {agentBox}
            </div>
            <div className="col">{requestBox}</div>
          </>
        ) : (
          <div className="col">
            {modelBox}
            {strategyBox}
            {signBox}
            {agentBox}
            {requestBox}
          </div>
        )}
      </main>
      <footer className="foot">
        <div className="status" aria-live="polite">
          <span className="mode">{" ENTER "}</span>
          <span className={busy ? "warn" : (msg?.c ?? "dim")}>
            {busy ? ` … ${busy}` : msg ? ` ${msg.t}` : " 1 model · 2 strategy · 3 sign · 4 watch · 5 the request"}
          </span>
          <span className="grow" />
        </div>
      </footer>
    </div>
  );
}
