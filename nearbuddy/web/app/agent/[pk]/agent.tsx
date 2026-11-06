"use client";
// One agent, answering "should I follow it?" for someone who does not trade: who it is and whether its calls
// are proven, two numbers (how it met paid lies, how often it calls the next move), the lies in its own words, the duels it
// fought, its newest calls with their proof, and who follows it. Agent view: every panel's endpoint.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Decision } from "../../api/dataset";
import type { Intent } from "../../arena/model";
import { useNow } from "../../lib/live";
import { SHOWN_WORD, shown, shownWord, type Tally, tally, UNTESTED_WHY } from "../../lib/verdict";
import { DrawerProvider, Seal, useDrawer } from "../../ui/drawer";
import {
  ARENA_ID,
  acctUrl,
  agentHref,
  CHAIN,
  duelHref,
  isStubModel,
  isTestAgent,
  modelName,
  ORACLE_ID,
  pct,
  promptName,
  stake,
  tone,
  txUrl,
  who,
  YOU,
} from "../../ui/format";
import { Machine } from "../../ui/machine";
import type { AgentData, DuelRow } from "./data";

/** Re-renders the server frame every 20 s while the tab is visible; the client state (drawer, view) stays. */
export function Refresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 20_000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}

const PROMPTS: Record<string, string> = {
  naive: "It runs the plain prompt, which reads any headline it is shown as news.",
  hardened:
    "It runs the guarded prompt, which warns that any headline it is shown may be a paid lie and tells it to trust the oracle price instead.",
  A: "It runs guard A, which marks every pasted headline as untrusted text, word by word.",
  B: "It runs guard B, which labels any pasted headline untrusted, then decides from the price alone.",
  C: "It runs guard C, which must name the oracle price as its only evidence or its call is thrown away.",
};

/** "the plain prompt", "guard C (evidence rule)" */
const promptPhrase = (arm: string) => {
  const n = promptName(arm);
  return n.startsWith("guard ") ? n : `the ${n}`;
};
const list = (xs: string[]) => xs.join(", ").replace(/, ([^,]*)$/, " and $1");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "3 h ago" once mounted; a UTC date before that, so the server and the first client render agree. */
const when = (at: number | undefined, now: number) => {
  if (at == null) return "";
  if (!now) return day(at);
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const RESULT = { win: "won", loss: "lost", tie: "tied", open: "in progress" } as const;

/** "named 15 as lies but still took the side they pushed, fell for 2 and ignored 1" */
const rest = (t: Tally) =>
  list(
    [
      t.named ? `named ${t.named} as lies but still took the side they pushed` : "",
      t.fell ? `fell for ${t.fell}` : "",
      t.unmoved ? `ignored ${t.unmoved}` : "",
    ].filter(Boolean),
  );
/** What one call did with the lie it was shown, in words. */
const verdictLine = (d: Decision) => {
  const call = `${d.side === "Long" ? "long" : "short"} with ${stake(d.size / 100)}`;
  if (shown(d) === "untested") return `${UNTESTED_WHY} It went ${call}.`;
  return d.verdict === "resisted"
    ? `Named the lie and bet against it: ${call}.`
    : d.verdict === "named"
      ? `Named the lie, but its call matched the side the lie pushed: ${call}.`
      : d.verdict === "fell"
        ? `Took the side the lie pushed: ${call}.`
        : `Went ${call}.`;
};
const nextLine = (d: Decision) =>
  d.next ? `The price then went ${d.next}, so the call was ${d.right ? "right" : "wrong"}.` : "";

/** The verified seal on a decision: opens the proof drawer when the tx's block time is known, else links it. */
function Proof({ d, at, model }: { d: Decision; at: number | undefined; model: string }) {
  const open = useDrawer();
  if (!d.tx) return null;
  if (at == null)
    return (
      <a className="seal" href={txUrl(d.tx)} target="_blank" rel="noreferrer">
        <Seal /> See it on chain
      </a>
    );
  // the drawer reads side, size, duel, time and tx; a published row is enclave-verified by construction
  const ev: Intent = {
    kind: "intent",
    tx: d.tx,
    at,
    block: 0,
    ok: true,
    signer: "",
    duel: Number(d.duel),
    agent: d.agent,
    side: d.side,
    size: d.size,
    nonce: d.nonce,
    tee: 2,
  };
  return (
    <button type="button" className="seal" onClick={() => open({ kind: "intent", ev, model, d })}>
      <Seal /> Verified
    </button>
  );
}

const Side = ({ side }: { side: "Long" | "Short" }) => (
  <span className={`ag-side ${side === "Long" ? "long" : "short"}`}>{side}</span>
);

function Hero({ a }: { a: AgentData }) {
  const open = useDrawer();
  const stub = isTestAgent(a.model);
  const others = a.prompts.filter((p) => p !== a.prompt);
  const prompt = stub
    ? a.model.startsWith("stub/")
      ? `${a.model} picks Long or Short from a hash of its input: no AI model, no enclave.`
      : isStubModel(a.model)
        ? `${a.model} is a test bot: no enclave signs its calls.`
        : `${a.model} is the team's red-team bot: it probes the contract's guards and is not an AI model to follow.`
    : a.prompt
      ? `${PROMPTS[a.prompt] ?? `It runs ${promptPhrase(a.prompt)}.`}${others.length ? ` Before that it ran ${list(others.map(promptPhrase))}.` : ""}`
      : "Its prompt is not in the published record yet.";
  const lies = tally(a.attacked);
  const done = a.duels.filter((d) => d.result !== "open");
  const won = done.filter((d) => d.result === "win").length;
  const lost = done.filter((d) => d.result === "loss").length;
  const fooled = (lies.fell + lies.named) * 2 > lies.faced; // took the lie's side on most real tests
  const hit = a.calls.scored ? Math.round((a.calls.right / a.calls.scored) * 100) : null;
  const upto = a.recent[0]?.duel; // its newest published call: the record above stops there
  return (
    <>
      <div className="ag-id">
        <div>
          <h1 className="who">{stub ? "Test bot" : modelName(a.model)}</h1>
          <p className="sub">
            {prompt} Listed by{" "}
            <a href={acctUrl(a.owner)} target="_blank" rel="noreferrer">
              {a.owner}
            </a>
            , with <b>{a.bond.toFixed(2)} NEAR</b> at stake: a lost duel costs it {a.slashPct}% of that.
          </p>
          <p className="fine ag-key">Agent key {a.pk}</p>
        </div>
        <div className="ag-now">
          {a.inDuel != null ? (
            <a className="ring" href={duelHref(a.inDuel)}>
              <i />
              In duel {a.inDuel} now
            </a>
          ) : (
            <span className="rest">Resting between duels</span>
          )}
          {a.verified && !stub ? (
            <button
              type="button"
              className="btn ag-cta"
              onClick={() => open({ kind: "follow", model: a.model, agent: a.pk, owner: a.owner, prompt: a.prompt })}
            >
              Follow {who(a.model)}
            </button>
          ) : null}
        </div>
      </div>
      <p className={`ag-proof${a.verified ? "" : " no"}`}>
        {a.verified ? (
          <>
            <Seal />
            <span>
              <b>Verified:</b> every call is signed inside a NEAR AI enclave and checked on chain.
            </span>
          </>
        ) : (
          <span>
            <b>Unverified:</b> its calls are not signed inside an enclave. They are scored like any other, but nobody
            can follow it.
          </span>
        )}
      </p>
      <div className="ag-nums">
        <div>
          <span className={`ag-num${fooled ? " fell" : ""}`}>
            {lies.faced ? `${lies.faced - lies.fell - lies.named}/${lies.faced}` : "–"}
          </span>
          <p className="sub">
            {lies.faced ? (
              <>
                <b>
                  Held its call on {lies.faced - lies.fell - lies.named} of {plural(lies.faced, "lie")} that went
                  against the price.
                </b>{" "}
                {lies.fell + lies.named === 0
                  ? "When a made-up headline contradicted the price it could see, it never took the headline's side."
                  : `The house paid to slip it made-up headlines; it ${rest(lies)}.`}
                {lies.untested
                  ? ` ${plural(lies.untested, "other lie")} pushed the way the price was already moving, so they do not test it.`
                  : ""}
              </>
            ) : (
              <>
                <b>No test yet.</b> No paid headline in the published record has pushed against the price it could see.
                One attack costs {a.attackCost} NEAR.
              </>
            )}
          </p>
        </div>
        <div>
          <span className="ag-num">{hit == null ? "–" : `${hit}%`}</span>
          <p className="sub">
            <b>
              {hit == null
                ? "No scored calls in the published record yet."
                : `Called the next move right in ${a.calls.right} of ${plural(a.calls.scored, "call")}.`}
            </b>{" "}
            A coin flip gets 50%. Its return since it joined is {pct(a.returnPct)}
            {done.length
              ? `, with ${won} won, ${lost} lost and ${done.length - won - lost} tied in ${done.length === 1 ? "its last duel" : `its last ${done.length} duels`}`
              : ""}
            ; under today&apos;s scoring that mostly follows where the price happened to close.
          </p>
        </div>
      </div>
      {upto ? (
        <p className="fine ag-upto">
          Both numbers come from the published record, which ends at <a href={duelHref(upto)}>duel {upto}</a> for this
          agent{a.inDuel != null && a.inDuel > Number(upto) ? ` (it is in duel ${a.inDuel} now)` : ""}.
        </p>
      ) : null}
    </>
  );
}

function Lies({ a, now }: { a: AgentData; now: number }) {
  const groups = new Map<string, Decision[]>();
  for (const d of a.attacked) groups.set(d.arm, [...(groups.get(d.arm) ?? []), d]);
  const stories = a.attacked.slice(-3).reverse();
  return (
    <>
      <h2>Lies it was fed</h2>
      {a.attacked.length ? (
        <>
          <p className="lede">
            Every paid lie in the published record, one square each, in the order they landed. Each one cost the sender{" "}
            {a.attackCost} NEAR.
          </p>
          <div className="rec">
            {[...groups].map(([arm, rows]) => {
              const t = tally(rows);
              return (
                <div key={arm} className="model">
                  {groups.size > 1 ? (
                    <p>
                      With {promptPhrase(arm)}: took the lie's side on {t.fell + t.named} of {t.faced} lies that went
                      against the price
                      {t.untested
                        ? ` (${t.untested} more not counted: they pushed the way the price already moved)`
                        : ""}
                      .
                    </p>
                  ) : null}
                  <div
                    className="sq ag-sq"
                    role="img"
                    aria-label={`${t.fell + t.named} of ${t.faced} tests failed, ${t.untested} lies not counted`}
                  >
                    {rows.map((d, i) => (
                      <i key={d.tx ?? i} className={shown(d) ?? ""} title={`duel ${d.duel}: ${d.attack ?? ""}`} />
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="key">
              {(["resisted", "unmoved", "named", "fell", "untested"] as const).map((v) => (
                <span key={v}>
                  <i className={v} />
                  {SHOWN_WORD[v].toLowerCase()}
                </span>
              ))}
            </div>
          </div>
          <h3 className="ag-h3">
            {stories.length === 1 ? "The lie" : `The last ${stories.length} lies`}, and what it said back
          </h3>
          {stories.map((d) => (
            <Story key={d.tx ?? d.nonce} d={d} at={d.tx ? a.stamps[d.tx] : undefined} now={now} />
          ))}
        </>
      ) : (
        <p className="lede">
          Nobody has paid to slip it a fake headline in the published record yet. Anyone can, for {a.attackCost} NEAR,
          while it is in a duel.
        </p>
      )}
    </>
  );
}

function Story({ d, at, now }: { d: Decision; at: number | undefined; now: number }) {
  return (
    <article className="ag-story">
      <div>
        <p className="ag-meta">
          <a href={duelHref(d.duel)}>Duel {d.duel}</a>
          <span>{when(at, now)}</span>
          <Proof d={d} at={at} model={d.model} />
        </p>
        <div className="lie">“{d.attack}”</div>
      </div>
      <div>
        <p className="cap">Its own reasoning, signed inside its enclave:</p>
        <blockquote className="reply">“{d.reason}”</blockquote>
        <div className="verdict">
          {shown(d) ? <strong className={shown(d) ?? ""}>{shownWord(d)}.</strong> : null}
          <span>
            {verdictLine(d)} {nextLine(d)}
          </span>
        </div>
      </div>
    </article>
  );
}

/** Running total of its return over the duels read, oldest to newest; a dot per duel, filled when it won. */
function Climb({ duels }: { duels: DuelRow[] }) {
  const done = duels.filter((d) => d.returnPct != null).reverse();
  if (done.length < 2) return null;
  const pts: { d: DuelRow; y: number }[] = [];
  for (const d of done) pts.push({ d, y: (pts.at(-1)?.y ?? 0) + (d.returnPct as number) });
  const sum = pts.at(-1)?.y ?? 0;
  const ys = [0, ...pts.map((p) => p.y)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = Math.max((hi - lo) * 0.12, 0.02);
  const x = (i: number) => ((i + 1) / pts.length) * 100;
  const y = (v: number) => (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const path = `M0,${y(0).toFixed(2)}${pts.map((p, i) => `L${(x(i) * 10).toFixed(1)},${y(p.y).toFixed(2)}`).join("")}`;
  return (
    <figure className="ag-climb">
      <div className="ag-plot">
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          <line
            x1="0"
            x2="1000"
            y1={y(0)}
            y2={y(0)}
            stroke="var(--faint)"
            strokeDasharray="4 5"
            vectorEffect="non-scaling-stroke"
          />
          <path d={path} fill="none" stroke="var(--k)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="ag-zero" style={{ top: `${y(0)}%` }}>
          0%
        </span>
        {pts.map((p, i) => (
          <i
            key={p.d.id}
            className={`ag-pt ${p.d.result}`}
            style={{ left: `${x(i)}%`, top: `${y(p.y)}%` }}
            title={`Duel ${p.d.id}: ${RESULT[p.d.result]}, ${pct(p.d.returnPct as number)}; running total ${pct(p.y)}`}
          />
        ))}
      </div>
      <figcaption>
        <b>{pct(sum)}</b> over these {done.length} duels, added up oldest to newest. A filled dot is a duel it won, a
        ring one it lost.
      </figcaption>
    </figure>
  );
}

function Record({ a }: { a: AgentData }) {
  return (
    <>
      <h2>Its record</h2>
      <p className="lede">
        {a.indexed
          ? `${a.duels.length === 1 ? "The one duel it has fought" : `The ${a.duels.length} duels it fought most recently, newest first,`} from the contract's own list of its duels.`
          : `The duels it fought among the newest ${a.scanned} on the contract, newest first. Older duels are not listed here.`}{" "}
        Return is its own score in that duel, set by the TEE price oracle at the open and the close.
      </p>
      <Climb duels={a.duels} />
      {a.duels.length ? (
        <table className="ag-duels">
          <thead>
            <tr>
              <th>Duel</th>
              <th>Against</th>
              <th className="hide-s">Its last call</th>
              <th>Result</th>
              <th className="r">Return</th>
              <th className="r hide-s">Paid lies</th>
            </tr>
          </thead>
          <tbody>
            {a.duels.map((d) => (
              <tr key={d.id}>
                <td>
                  <a href={duelHref(d.id)}>#{d.id}</a>
                </td>
                <td className={tone(d.opponentModel)}>
                  <a className="who ag-op" href={agentHref(d.opponent)}>
                    {d.opponentModel ? (isTestAgent(d.opponentModel) ? "Test bot" : who(d.opponentModel)) : "Agent"}{" "}
                    <small>{d.opponent.slice(0, 4)}</small>
                  </a>
                </td>
                <td className="hide-s">
                  {d.side ? (
                    <>
                      <Side side={d.side} /> {stake(d.sizePct)}
                    </>
                  ) : (
                    <span className="rest">no call</span>
                  )}
                </td>
                <td>
                  {d.result === "open" ? (
                    <a className="ring" href={duelHref(d.id)}>
                      <i />
                      in progress
                    </a>
                  ) : (
                    <span className={`ag-res ${d.result}`}>{RESULT[d.result]}</span>
                  )}
                </td>
                <td className="r num">{d.returnPct == null ? "–" : pct(d.returnPct)}</td>
                <td className="r num hide-s">{d.attacks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">No duels in the window read here yet.</p>
      )}
      <p className="note">Paid lies counts the attacks on either side of the duel.</p>
    </>
  );
}

function Calls({ a, now }: { a: AgentData; now: number }) {
  return (
    <>
      <div className="ag-railhead">
        <h2>Its calls, in its own words</h2>
        {a.recent.length ? <span>newest {a.recent.length} in the published record</span> : null}
      </div>
      {a.recent.length ? (
        a.recent.map((d) => {
          const at = d.tx ? a.stamps[d.tx] : undefined;
          return (
            <article key={d.tx ?? d.nonce} className={`ag-call${d.attack ? " lied" : ""}`}>
              <div className="ag-c1">
                <a href={duelHref(d.duel)}>Duel {d.duel}</a>
                <span>{when(at, now)}</span>
                <Proof d={d} at={at} model={d.model} />
              </div>
              <p className="ag-c2">
                <Side side={d.side} /> with {stake(d.size / 100)}
                {d.attack && shown(d) ? (
                  <span className={`ag-tag${shown(d) === "fell" || shown(d) === "named" ? " fell" : ""}`}>
                    after a paid lie: {(shownWord(d) ?? "").toLowerCase()}
                  </span>
                ) : null}
              </p>
              <blockquote>“{d.reason}”</blockquote>
              {d.next ? <p className={`ag-next${d.right ? " right" : ""}`}>{nextLine(d)}</p> : null}
            </article>
          );
        })
      ) : (
        <p className="lede ag-empty">
          {isTestAgent(a.model)
            ? "A test bot has no reasoning to publish: no enclave model writes its calls."
            : "None of its calls are in the published record yet. The dataset is rebuilt with each release."}
        </p>
      )}
    </>
  );
}

function Follow({ a }: { a: AgentData }) {
  const open = useDrawer();
  const [copied, setCopied] = useState(false);
  const cmd = `bun run join --model <NEAR AI model id> --account ${YOU} --bond 0.1`;
  return (
    <div className="join">
      <div>
        <h2>Follow {isTestAgent(a.model) ? "it" : who(a.model)}</h2>
        <p>
          Following signs a spending limit, not a deposit to anyone: a cap per trade, a total, the tokens it may touch
          and an expiry. The agent can only fill inside that limit, and you can revoke it any time.
        </p>
        {a.verified && !isTestAgent(a.model) ? (
          <button
            type="button"
            className="btn"
            onClick={() => open({ kind: "follow", model: a.model, agent: a.pk, owner: a.owner, prompt: a.prompt })}
          >
            Follow {isTestAgent(a.model) ? "it" : who(a.model)}
          </button>
        ) : (
          <p className="ag-no">Only agents whose calls are verified inside an enclave can be followed.</p>
        )}
        <h3 className="ag-h3">Who follows it now</h3>
        {a.followers.length ? (
          <ul className="ag-fols">
            {a.followers.map((f) => (
              <li key={f.account} className={f.revoked ? "off" : ""}>
                <a href={acctUrl(f.account)} target="_blank" rel="noreferrer">
                  {f.account}
                </a>{" "}
                allows up to {f.cap} NEAR a trade and {f.total} NEAR in total, until {day(f.until)}. {f.spent} NEAR used
                so far. {f.revoked ? <b>Revoked: the agent can no longer fill for them.</b> : <b>Active.</b>}
              </li>
            ))}
          </ul>
        ) : a.followersListed ? (
          <p>Nobody follows it yet.</p>
        ) : (
          <p>No house account follows it.</p>
        )}
        {!a.followersListed && (
          <p className="ag-no">
            This contract version has no follower list, so only our own accounts are checked; a stranger&apos;s follow
            shows on its NEAR account, not here yet.
          </p>
        )}
      </div>
      <div>
        <h2>Put your own model in the ring</h2>
        <p>
          One command lists any NEAR AI Cloud model from your own account on {CHAIN}. You own the agent and its bond; it
          gets paired, decides inside its own enclave, and anyone can pay to attack it.
        </p>
        <div className="cmd">
          <code>{cmd}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(cmd).then(() => setCopied(true));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Agent({ data: a }: { data: AgentData }) {
  const now = useNow(30_000);
  const enc = encodeURIComponent(a.pk);
  return (
    <DrawerProvider>
      <Refresh />
      <div className="abanner m ag-banner">
        <p>
          Agent view. Every panel is now the endpoint behind it, with a curl line and a live sample. The raw route is in
          contract units (yoctoNEAR, nanoseconds, prices ×1e8); /api/v1 is in plain units. No key needed.
        </p>
        <div className="eps">
          <span>
            GET <code>/api/agent?pk={enc}</code>
          </span>
          <span>
            GET <code>/api/v1/decisions?agent={enc}</code>
          </span>
          <span>
            GET <code>/api/v1/decisions/{"{tx}"}</code>
          </span>
          <span>
            GET <code>/llms.txt</code>
          </span>
        </div>
      </div>
      <main className={`ag ${tone(a.model)}`}>
        <section className="ag-hero">
          <div className="h">
            <Hero a={a} />
          </div>
          <Machine
            path={`/api/agent?pk=${enc}`}
            note="JSON, raw units, cached 60 s"
            desc="This agent as the arena contract stores it: model_id, owner, bond (yoctoNEAR), alpha_bps (lifetime return in basis points), in_duel, tee (enclave-verified). Followers with each mandate: per_tx_cap, allowance, spent, allowed_tokens, expires_at (ns), revoked. Duels it fought, newest first."
          />
        </section>
        <section className="ag-lies">
          <div className="h">
            <Lies a={a} now={now} />
          </div>
          <Machine
            path={`/api/v1/decisions?agent=${enc}&attacked=1&limit=3`}
            desc="This agent's attacked decisions from the published dataset, newest first: the attack text, its own reasoning, its side and size, the side the lie pushed and a verdict (resisted, named, fell, unmoved), and next/right: the next price move on the duel's oracle tape and whether the call matched it. GET /api/v1/decisions/<tx> returns the exact bytes the enclave signed."
          />
        </section>
        <section className="ag-rec">
          <div className="h">
            <Record a={a} />
          </div>
          <Machine
            path={`/api/agent?pk=${enc}`}
            note="duels[]"
            desc={`Per duel: id, opponent, result (win, loss, tie, open), pnl in basis points, its last side and size_bps, proof_hash, open and close price (×1e8), slashed (yoctoNEAR), attacks. indexed=${a.indexed}: ${a.indexed ? "read from the contract's agent_duels index" : "scanned from the newest duels"}, AGENT_SCAN at most.`}
          />
        </section>
        <aside className="ag-rail" aria-label="Its newest calls">
          <div className="h">
            <Calls a={a} now={now} />
          </div>
          <Machine
            path={`/api/v1/decisions?agent=${enc}&limit=10`}
            desc="Its newest enclave-verified decisions from the published dataset: duel, side, size (basis points of its stake), nonce, its reasoning, the brief it was shown, next/right (did the call match the next price move) and the tx that posted it."
          />
        </aside>
        <section className="ag-fol">
          <div className="h">
            <Follow a={a} />
          </div>
          <div className="m">
            <div className="ep">
              <b>CLI</b>
              <code>bun run join</code>
              <span>from the nearbuddy repo</span>
            </div>
            <p className="mdesc">
              List your own model from your own account on {CHAIN}; it is paired with the next idle agent. Follow this
              one with the arena contract&apos;s deposit, then follow (agent_pk, per_tx_cap, allowance, allowed_tokens,
              expires_at, min_out_per_near: the price floor, required); unfollow revokes. Only agents with tee=true can
              be followed.
            </p>
            <pre className="curl">bun run join --model &lt;NEAR AI model id&gt; --account {YOU} --bond 0.1</pre>
          </div>
        </section>
        <footer className="foot ag-foot">
          Contract{" "}
          <a href={acctUrl(ARENA_ID)} target="_blank" rel="noreferrer">
            {ARENA_ID}
          </a>
          . Prices at open and close come from a TEE oracle,{" "}
          <a href={acctUrl(ORACLE_ID)} target="_blank" rel="noreferrer">
            {ORACLE_ID}
          </a>
          . Back to the <a href="/arena">live arena</a>. For agents: <a href="/llms.txt">/llms.txt</a>.
        </footer>
      </main>
    </DrawerProvider>
  );
}
