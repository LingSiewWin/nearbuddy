"use client";
// One planted headline after it landed: the wait panel (step 4), the result panel (step 5), collecting the money and
// the share sheet. Used by the duel page (YOUR HEADLINE) and by /i/[tx]; every word comes from ui/verdict.ts.
import { type ReactNode, useEffect, useState } from "react";
import type { Chaos } from "../lib/abi/arena";
import { claimable, claimCall } from "../lib/inject";
import * as wallet from "../lib/wallet";
import { txHref } from "../tui";
import { clock, near } from "./format";
import { Button, LinkButton, Sheet, Skeleton, StatusBar } from "./kit";
import type { TraceIn } from "./trace";
import { Trace, WhatHappened } from "./trace-view";
import { coinFlip, type DuelEnd, gapLine, moneyLine, sentence, shareText, VERDICT, type Viewer } from "./verdict";

/** A planted headline: serif, in quotes, and nothing else is ever set in serif. */
export function Headline({ text, as = "block" }: { text: string; as?: "block" | "line" }) {
  return <blockquote className={`hl ${as}`}>{`“${text}”`}</blockquote>;
}

/** The verdict word: a stamp (the big one) or a tag (in lists). `fresh` plays the appearance once. */
export function VerdictWord({
  outcome,
  size,
  fresh,
}: {
  outcome: Chaos["outcome"];
  size: "stamp" | "tag";
  fresh?: boolean;
}) {
  if (outcome === "Pending") return <span className="vtag caution">waiting</span>;
  const v = VERDICT[outcome];
  return size === "stamp" ? (
    <p className={`t-verdict verdict ${v.tone}${fresh ? " fresh" : ""}`}>{v.word}</p>
  ) : (
    <span className={`vtag ${v.tone}`}>{v.word}</span>
  );
}

/** The AI's own words, in mono. Clamped to four lines with `Read all`; a decision with no written reason says so. */
export function MachineQuote({ text, clamp }: { text: string | null; clamp?: boolean }) {
  const [all, setAll] = useState(false);
  if (!text) return <p className="t-small dim">This decision carried no written reason.</p>;
  return (
    <div className="mq">
      <p className={`t-mono${clamp && !all ? " clamp" : ""}`}>{`“${text}”`}</p>
      {clamp && !all && text.length > 160 ? (
        <button type="button" className="btn-link" onClick={() => setAll(true)}>
          Read all
        </button>
      ) : null}
    </div>
  );
}

function CopyLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-link"
      onClick={() => navigator.clipboard.writeText(new URL(path, location.origin).href).then(() => setCopied(true))}
    >
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}

/** Step 4: the headline is planted and its target has not decided again. The count is up, not down: nobody knows
 *  when it will decide. */
export function WaitPanel({
  c,
  model,
  viewer,
  asWritten,
  trace,
  time,
  locked,
  decisionTimes,
  closeMs,
  now,
  link,
  plantedMs,
}: {
  c: Chaos;
  model: string;
  viewer: Viewer;
  asWritten: boolean;
  trace: TraceIn;
  time?: (ms: number) => string | null;
  /** A decision made after the pin is already in. */
  locked: boolean;
  /** The target's decision times in this duel, for the "came about N min apart" line. */
  decisionTimes: number[];
  closeMs: number;
  now: number;
  /** /i/{tx}, when the transaction is known. */
  link: string | null;
  plantedMs: number;
}) {
  const [flip, setFlip] = useState(false);
  // the coin-flip line appears 0.6 s after the panel does
  useEffect(() => {
    const t = setTimeout(() => setFlip(true), 600);
    return () => clearTimeout(t);
  }, []);
  const flipLine = coinFlip(c.arm, "will", viewer, asWritten);
  return (
    <div className="stack">
      <div className="hrow">
        <h2 className="t-label">{viewer === "attacker" ? "Your headline" : "Planted headline"}</h2>
        <span className="end">
          <VerdictWord outcome="Pending" size="tag" />
        </span>
      </div>
      <Headline text={c.headline} />
      <Trace variant="mini" name={model} input={trace} {...(time ? { time } : {})} />
      <div className="stack-2">
        <p>
          {locked
            ? "Its next decision is locked in. The result follows shortly."
            : `Waiting for ${model}'s next decision.`}
        </p>
        <p className="mono">{now ? `Planted ${clock((now - plantedMs) / 1000)} ago` : "Planted"}</p>
        <p className="t-small dim">{gapLine(decisionTimes)}</p>
        <p className="mono">{now && closeMs > now ? `Duel ends in ${clock((closeMs - now) / 1000)}` : "Duel closed"}</p>
      </div>
      {flip && flipLine ? (
        <p>
          <span className="t-label">Coin flip</span> {flipLine}
        </p>
      ) : null}
      <p className="t-small dim">
        You can leave. The result will be here when you come back. {link ? <CopyLink path={link} /> : null}
      </p>
      <p className="t-small dim">
        While you wait: in the lab, about 1 in 9 decisions changed on a re-run with no attack at all. One result is one
        result.
      </p>
    </div>
  );
}

/** Step 5: the verdict, the headline, the two-segment Trace, the sentence, the AI's reason, how it saw the headline,
 *  the money line and the actions. */
export function ResultPanel({
  c,
  model,
  viewer,
  asWritten,
  end,
  feeBps,
  reason,
  trace,
  time,
  fresh,
  actions,
  links,
}: {
  c: Chaos;
  model: string;
  viewer: Viewer;
  asWritten: boolean;
  end: DuelEnd;
  /** The arena's attack fee (ChaosConfig.fee_bps). */
  feeBps: number;
  /** The AI's reason for the deciding decision; null when it carried none. */
  reason: string | null;
  trace: TraceIn;
  time?: (ms: number) => string | null;
  /** The verdict arrived while the visitor was on the page: play its appearance once. */
  fresh: boolean;
  actions?: ReactNode;
  links?: ReactNode;
}) {
  const flipLine = coinFlip(c.arm, "saw", viewer, asWritten);
  const decided = c.outcome === "Flipped" || c.outcome === "Held";
  return (
    <div className={`stack result${fresh ? " fresh" : ""}`}>
      <VerdictWord outcome={c.outcome} size="stamp" fresh={fresh} />
      <Headline text={c.headline} />
      <Trace variant="mini" name={model} input={trace} {...(time ? { time } : {})} />
      <p>{sentence(c, viewer)}</p>
      {decided ? <MachineQuote text={reason} /> : null}
      {flipLine ? <p className="t-small dim">{flipLine}</p> : null}
      <p>{moneyLine(c, end, feeBps, viewer)}</p>
      {actions ? <div className="actions">{actions}</div> : null}
      {links ? <div className="hrow">{links}</div> : null}
      {decided ? (
        <p className="t-small dim">
          One attack is one data point. About 1 in 9 decisions change on a re-run with no attack. See the{" "}
          <a href="/board">scoreboard</a> for the pattern.
        </p>
      ) : null}
      <WhatHappened items={[{ name: model, input: trace, ...(time ? { time } : {}) }]} />
    </div>
  );
}

/** `Collect {amount} NEAR`: one call pays everything the account is owed in that duel. Shown only once the duel has
 *  finished and money is owed; after it, "Collected." */
export function Collect({
  records,
  account,
  contract,
  duelId,
  finished,
  onDone,
}: {
  records: Chaos[];
  account: string | null;
  contract: string;
  duelId: string;
  finished: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [paid, setPaid] = useState<{ amount: bigint; tx: string } | null>(null);
  if (!account || !finished) return null;
  const mine = records.filter((r) => r.injector === account && BigInt(r.payout) > 0n);
  const owed = claimable(records, account);
  if (paid)
    return (
      <p>
        {`Collected ${near(paid.amount)}. `}
        <a href={txHref(paid.tx)} target="_blank" rel="noreferrer">
          See the transaction
        </a>
      </p>
    );
  if (owed === 0n) return mine.length ? <p>Collected.</p> : null;
  const k = mine.filter((r) => !r.claimed).length;
  return (
    <div>
      <Button
        variant="primary"
        busy={busy ? "Collecting…" : null}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            const { hash } = await wallet.sendFor(claimCall(contract, duelId));
            setPaid({ amount: owed, tx: hash });
            onDone();
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {`Collect ${near(owed)}`}
      </Button>
      {k > 1 ? <p className="btn-why">{`Covers all ${k} of your headlines in this duel.`}</p> : null}
      {failed ? <StatusBar kind="error">Could not collect. Your money is still waiting. Try again.</StatusBar> : null}
    </div>
  );
}

/** The share sheet: the card image, `Save image`, `Copy link`, and the native share button where there is one. */
export function ShareSheet({
  open,
  onClose,
  tx,
  model,
  outcome,
}: {
  open: boolean;
  onClose: () => void;
  tx: string;
  model: string;
  outcome: Chaos["outcome"];
}) {
  const [state, setState] = useState<"building" | "ready" | "failed">("building");
  const [native, setNative] = useState(false);
  useEffect(() => {
    if (open) {
      setState("building");
      setNative(typeof navigator.share === "function");
    }
  }, [open]);
  const img = `/api/card?tx=${encodeURIComponent(tx)}&v=${outcome}`;
  const path = `/i/${tx}`;
  return (
    <Sheet open={open} onClose={onClose} title="Share">
      <div className="stack">
        <div className="card-preview">
          {state === "building" ? (
            <div className="card-wait">
              <Skeleton bars={["100%"]} />
              <p className="t-small dim">Making the image…</p>
            </div>
          ) : null}
          {state === "failed" ? (
            <StatusBar kind="error">Could not make the image. You can still copy the link.</StatusBar>
          ) : (
            // biome-ignore lint/performance/noImgElement: a generated image from this site's own route, no optimiser needed
            <img
              src={img}
              alt={`Share card: ${shareText(model, outcome, "")}`.trim()}
              width={1200}
              height={630}
              hidden={state !== "ready"}
              onLoad={() => setState("ready")}
              onError={() => setState("failed")}
            />
          )}
        </div>
        <div className="actions">
          {state === "ready" ? (
            <LinkButton variant="quiet" href={img} download={`nearbuddy-${tx.slice(0, 8)}.png`}>
              Save image
            </LinkButton>
          ) : null}
          <CopyLink path={path} />
          {native ? (
            <Button
              variant="quiet"
              onClick={() => {
                const url = new URL(path, location.origin).href;
                navigator.share({ text: shareText(model, outcome, url) }).catch(() => {});
              }}
            >
              Share
            </Button>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
