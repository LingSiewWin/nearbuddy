"use client";
// The middle of the page: what just happened (the newest paid lie and the target's own reply), who falls for
// fake news (one square per attack, per agent), the standings (hardest to fool first, or best return), and
// how to take part.
import { useState } from "react";
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import { Seal, useDrawer } from "../ui/drawer";
import { agentHref, ago, duelHref, modelName, pct, promptName, stake, tone, who } from "../ui/format";
import type { Story } from "./model";

export function News({ story, now }: { story: Story | null; now: number }) {
  const open = useDrawer();
  if (!story) return <p className="lede">No attacks yet.</p>;
  const k = tone(story.model);
  const name = <span className={`who ${k}`}>{who(story.model)}</span>;
  const d = story.d;
  const side = story.reply?.side ?? d?.side;
  const size = story.reply ? story.reply.size / 100 : d ? d.size / 100 : null;
  const verdict = d?.verdict;
  return (
    <div className={k}>
      <h2>
        What just happened
        <span className="when">
          {story.attack ? (now ? ago(story.attack.at, now) : "") : `from duel ${story.duel}, published dataset`}
        </span>
      </h2>
      <p className="lead">
        Someone paid {story.attack ? "0.1 NEAR " : ""}to slip {name} a fake headline.
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
          {story.reply.side} with {stake(story.reply.size / 100)}. Its reasoning is published with the dataset.
        </p>
      ) : (
        <p className="cap">Waiting for {who(story.model)}&apos;s next call.</p>
      )}
      {side ? (
        <div className="verdict">
          {verdict === "spotted" ? (
            <strong>Called it out.</strong>
          ) : verdict === "fell" ? (
            <strong className="fell">Fell for it.</strong>
          ) : verdict === "unmoved" ? (
            <strong>Unmoved.</strong>
          ) : null}
          <span>
            {verdict === "spotted"
              ? `Named the lie and went ${side === "Long" ? "long" : "short"} with ${stake(size)}.`
              : verdict === "fell"
                ? `Took the side the lie pushed: ${side === "Long" ? "long" : "short"} with ${stake(size)}.`
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
      <p className="lede">Every paid lie in the published record, one square each, in the order they landed.</p>
      {list.map(([k, rows]) => {
        const first = rows[0] as Decision;
        const fell = rows.filter((d) => d.verdict === "fell").length;
        const spotted = rows.filter((d) => d.verdict === "spotted").length;
        return (
          <div key={k} className={`model ${tone(first.model)}`}>
            <p>
              <span className="who">{who(first.model)}</span> with the {promptName(first.arm)}{" "}
              {fell === rows.length
                ? `fell for all ${rows.length}.`
                : spotted === rows.length
                  ? `called out all ${rows.length}.`
                  : `called out ${spotted}, fell for ${fell} of ${rows.length}.`}
            </p>
            <div className="sq" role="img" aria-label={`${spotted} called out, ${fell} fell for`}>
              {rows.map((d, i) => (
                <i key={d.tx ?? i} className={d.verdict ?? ""} title={`duel ${d.duel}: ${d.attack ?? ""}`} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="key">
        <span>
          <i />
          called it out
        </span>
        <span>
          <i className="fell" />
          fell for it
        </span>
        <span>
          <i className="unmoved" />
          unmoved
        </span>
      </div>
      <p className="note">
        Swapping the two prompts between the models swapped the results: it is the prompt, not the model.
      </p>
    </div>
  );
}

type Sort = "fool" | "return";
export function Standings({ s }: { s: Summary }) {
  const [sort, setSort] = useState<Sort>("fool");
  const open = useDrawer();
  const resist = (a: Summary["standings"][number]) =>
    a.attacks.faced ? (a.attacks.spotted - a.attacks.fell) / a.attacks.faced : -2;
  const rows = [...s.standings].sort((x, y) =>
    sort === "fool" ? resist(y) - resist(x) || y.return_pct - x.return_pct : y.return_pct - x.return_pct,
  );
  return (
    <>
      <h2>Standings</h2>
      <p className="lede">
        Follow the agents that are hard to fool, not just the lucky ones. Test bots without an enclave are hidden.
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
            <th>Paid lies</th>
            <th className="r">Return</th>
            <th className="r hide-s">Won · lost · level</th>
            <th className="r hide-s">At stake</th>
            <th className="hide-s">Now</th>
            <th />
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
                      {promptName(a.prompt)} · {a.owner.replace(".testnet", "")}
                    </small>
                  </a>
                </div>
              </td>
              <td>
                {a.attacks.faced ? (
                  a.attacks.fell ? (
                    <span className="fellc">
                      fell for {a.attacks.fell} of {a.attacks.faced}
                    </span>
                  ) : (
                    `called out ${a.attacks.spotted} of ${a.attacks.faced}`
                  )
                ) : (
                  <span className="rest">not attacked yet</span>
                )}
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
              <td className="r">
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

export function Join() {
  const [copied, setCopied] = useState(false);
  const cmd = "bun run join --model <NEAR AI model id> --account <you.testnet> --bond 0.1";
  return (
    <div className="join">
      <div>
        <h2>Put your own model in the ring</h2>
        <p>
          One command lists any NEAR AI Cloud model from your own testnet account. You own the agent and its bond; it
          gets paired, decides inside its own enclave, and strangers can attack it.
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
