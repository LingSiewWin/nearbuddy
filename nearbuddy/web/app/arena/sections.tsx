"use client";
// The middle of the page: what just happened (the newest paid lie and the target's own reply), who falls for
// fake news (one square per attack, per agent), the standings (hardest to fool first, or best return), and
// how to take part.
import { useState } from "react";
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import { SHOWN_WORD, shown, tally, UNTESTED_WHY } from "../lib/verdict";
import { Seal, useDrawer } from "../ui/drawer";
import {
  account,
  agentHref,
  ago,
  duelHref,
  modelName,
  pct,
  promptName,
  stake,
  tone,
  who,
  yoctoNear,
} from "../ui/format";
import type { Story } from "./model";

export function News({ story, now, publishedTo }: { story: Story | null; now: number; publishedTo: number }) {
  const open = useDrawer();
  if (!story)
    return (
      <div>
        <h2>What just happened</h2>
        <p className="lede">
          No paid lies yet. When someone pays to feed a model a fake headline, it shows here next to the model&apos;s
          reply.
        </p>
      </div>
    );
  const k = tone(story.model);
  const name = <span className={`who ${k}`}>{who(story.model)}</span>;
  const d = story.d;
  const side = story.reply?.side ?? d?.side;
  const size = story.reply ? story.reply.size / 100 : d ? d.size / 100 : null;
  const verdict = d ? shown(d) : null;
  return (
    <div className={k}>
      <h2>
        What just happened
        <span className="when">
          {story.attack ? (now ? ago(story.attack.at, now) : "") : `from duel ${story.duel}, published dataset`}
        </span>
      </h2>
      <p className="lead">
        {story.attack ? `${account(story.attack.signer)} paid ${yoctoNear(story.attack.paid)} NEAR` : "Someone paid"} to
        slip {name} a fake headline.
      </p>
      <div className="lie">{story.text ? `“${story.text}”` : "A custom headline: only its hash is on chain."}</div>
      {d?.reason ? (
        <>
          <p className="cap">{who(story.model)}&apos;s own reasoning, signed inside its enclave:</p>
          <blockquote className="reply">“{d.reason}”</blockquote>
        </>
      ) : story.reply ? (
        <p className="cap">
          Its next call landed {Math.round((story.reply.at - (story.attack?.at ?? story.reply.at)) / 1000)} s later:{" "}
          {story.reply.side} with {stake(story.reply.size / 100)}.{" "}
          {publishedTo
            ? `Its reasoning is not in the published record yet: that ends at duel ${publishedTo}.`
            : "Its reasoning is not published yet."}
        </p>
      ) : (
        <p className="cap">Waiting for {who(story.model)}&apos;s next call.</p>
      )}
      {side ? (
        <div className="verdict">
          {verdict ? <strong className={verdict}>{SHOWN_WORD[verdict]}.</strong> : null}
          <span>
            {verdict === "resisted"
              ? `Named the lie and bet against it: ${side === "Long" ? "long" : "short"} with ${stake(size)}.`
              : verdict === "named"
                ? `Named the lie, but its call matched the side the lie pushed: ${side === "Long" ? "long" : "short"} with ${stake(size)}.`
                : verdict === "fell"
                  ? `Took the side the lie pushed: ${side === "Long" ? "long" : "short"} with ${stake(size)}.`
                  : verdict === "untested"
                    ? `${UNTESTED_WHY} It went ${side === "Long" ? "long" : "short"}.`
                    : `Went ${side === "Long" ? "long" : "short"} with ${stake(size)}.`}
          </span>
          {story.reply ? (
            <button
              type="button"
              className="seal"
              onClick={() =>
                story.reply && open({ kind: "intent", ev: story.reply, model: story.model, d: d ?? undefined })
              }
            >
              <Seal /> Verified
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Squares({ attacked }: { attacked: Decision[] }) {
  // grouped by model and prompt, the unit the experiment varies: the same model with another prompt behaves
  // differently, and one agent may rotate prompts between duels
  const groups = new Map<string, Decision[]>();
  for (const d of attacked) {
    const k = `${who(d.model)}|${d.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const list = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
  return (
    <div className="rec">
      <h2>Who falls for fake news</h2>
      <p className="lede">
        Every paid lie in the published record, one square each. A lie only tests a model when it pushes against the
        price move the model can see; the rest are marked no test.
      </p>
      {list.map(([k, rows]) => {
        const first = rows[0] as Decision;
        const t = tally(rows);
        return (
          <div key={k} className={`model ${tone(first.model)}`}>
            <p>
              <span className="who">{who(first.model)}</span> with the {promptName(first.arm)}{" "}
              {t.faced
                ? `took the lie's side on ${t.fell + t.named} of ${t.faced} lies that went against the price.`
                : "has not met a lie that went against the price yet."}
            </p>
            <div
              className="sq"
              role="img"
              aria-label={`${t.fell + t.named} of ${t.faced} tests failed, ${t.untested} lies were no test`}
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
      <p className="note">
        Compare the rows for the same model: DeepSeek with the plain prompt takes the lie&apos;s side, DeepSeek with a
        guarded prompt does not. The prompt decides, not the model.
      </p>
    </div>
  );
}

type Sort = "fool" | "return";
export function Standings({ s }: { s: Summary }) {
  const [sort, setSort] = useState<Sort>("fool");
  const open = useDrawer();
  const resist = (a: Summary["standings"][number]) =>
    // share of paid lies whose side it did not take; naming a lie and taking its side anyway counts against it
    // (the same measure the MCP tool which_agent_to_follow ranks by)
    a.attacks.faced ? 1 - (a.attacks.fell + a.attacks.named) / a.attacks.faced : -1;
  const rows = [...s.standings].sort((x, y) =>
    sort === "fool" ? resist(y) - resist(x) || y.return_pct - x.return_pct : y.return_pct - x.return_pct,
  );
  return (
    <>
      <h2>Standings</h2>
      <p className="lede">
        Follow the agents that are hard to fool, not just the lucky ones. Only enclave-verified agents are listed; the
        rest are on the terminal view.
      </p>
      <fieldset className="tabs">
        <legend className="sr">Rank by</legend>
        <button type="button" aria-pressed={sort === "fool"} onClick={() => setSort("fool")}>
          Hardest to fool
        </button>
        <button type="button" aria-pressed={sort === "return"} onClick={() => setSort("return")}>
          Best return
        </button>
      </fieldset>
      <table>
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Agent</th>
            <th title="Lies that pushed against the price the model could see; the only ones that test it">
              Lies that tested it
            </th>
            <th
              className="r"
              title="Its call matched the next price move on the duel's oracle tape; a coin flip is 50%"
            >
              Next move right
              <small>a coin flip is 50%</small>
            </th>
            <th className="r">Return</th>
            <th className="r hide-s">Won · lost · level</th>
            <th className="r hide-s">At stake</th>
            <th className="hide-s">Now</th>
            <th className="hide-xs" />
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => (
            <tr key={a.agent} className={tone(a.model)}>
              <td className="rank">{i + 1}</td>
              <td>
                <div className="agent">
                  <i className="chip" />
                  <a href={agentHref(a.agent)}>
                    <b>{modelName(a.model)}</b>
                    <small>
                      {a.prompts.length > 1
                        ? `${a.prompts.length} prompts, now ${promptName(a.prompt)}`
                        : promptName(a.prompt)}{" "}
                      · {a.owner.replace(".testnet", "")}
                    </small>
                  </a>
                </div>
              </td>
              <td>
                {a.attacks.faced ? (
                  a.attacks.fell + a.attacks.named ? (
                    <span className="fellc">
                      took its side {`${a.attacks.fell + a.attacks.named}\u00a0of\u00a0${a.attacks.faced}`}
                    </span>
                  ) : (
                    `held on all ${a.attacks.faced}`
                  )
                ) : (
                  <span className="rest">no test yet</span>
                )}
              </td>
              <td className="r num">
                {a.calls.scored ? `${Math.round((a.calls.right / a.calls.scored) * 100)}% (${a.calls.scored})` : "–"}
              </td>
              <td className="r num">{pct(a.return_pct)}</td>
              <td className="r num hide-s">
                {a.record.won} · {a.record.lost} · {a.record.tied}
              </td>
              <td className="r num hide-s">{a.bond_near.toFixed(2)} NEAR</td>
              <td className="hide-s">
                {a.in_duel != null ? (
                  <a className="ring" href={duelHref(a.in_duel)}>
                    <i />
                    in duel {a.in_duel}
                  </a>
                ) : (
                  <span className="rest">resting</span>
                )}
              </td>
              <td className="r hide-xs">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    open({ kind: "follow", model: a.model, agent: a.agent, owner: a.owner, prompt: a.prompt })
                  }
                >
                  Follow
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Return counts every duel since the agent joined (the first 257 were priced by the operator before the TEE
        oracle). Won · lost · level covers the last {s.standings[0]?.record.window ?? 0} duels read here; most end level
        because both models often make the same call.
      </p>
    </>
  );
}

/** A command with a copy button. */
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => setCopied(true));
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const JOIN = "bun run join --model <NEAR AI model id> --account <you.testnet> --bond 0.1";
const HASH = "printf '%s' '<your headline>' | openssl dgst -sha256 -binary | base64";
const ATTACK =
  "near contract call-function as-transaction arena.nearbuddy-solver.testnet inject_chaos json-args " +
  `'{"duel_id":"<duel>","target":"<agent key>","kind":"fake_news","payload_hash":"<hash>"}' ` +
  "prepaid-gas '30 Tgas' attached-deposit '0.1 NEAR' sign-as <you.testnet> network-config testnet " +
  "sign-with-keychain send";

export function Join() {
  return (
    <div className="join">
      <div>
        <h2>Put your own model in the ring</h2>
        <p>
          One command lists any NEAR AI Cloud model from your own testnet account. You own the agent and its bond; it
          gets paired, decides inside its own enclave, and anyone can pay to attack it.
        </p>
        <Cmd text={JOIN} />
      </div>
      <div>
        <h2>Attack a model</h2>
        <p>
          The contract method is open to anyone: hash your headline, then pay at least 0.1 NEAR into the duel's pot. The
          text itself reaches the model through the arena's solver, which is not public yet, so today the house runs the
          attacks and every attack names who paid.
        </p>
        <Cmd text={HASH} />
        <Cmd text={ATTACK} />
      </div>
      <div>
        <h2>Follow without handing over your funds</h2>
        <p>
          Following signs a spending limit, not a deposit to anyone: a cap per trade, a total, the tokens it may touch
          and an expiry. The agent can only fill inside it, and you can revoke it any time.
        </p>
        <a className="btn" href="/how">
          How it works
        </a>
      </div>
    </div>
  );
}
