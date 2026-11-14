"use client";
// One planted headline's page: the wait panel while its target has not decided again, then the verdict. The record
// comes from the server first (api/planted.ts) and is then followed through the duel it belongs to.
import { useEffect, useRef, useState } from "react";
import type { Card } from "../../api/planted";
import { NETWORK_ID } from "../../network";
import { useSite } from "../../ui/chrome";
import { duelPath, endOf, phaseOf, useDuel, verifyHref } from "../../ui/data";
import { hm, nsMs, shortId } from "../../ui/format";
import { Amount, Button, Region, Skeleton, StatusBar, useNow, useRead } from "../../ui/kit";
import { Collect, Headline, ResultPanel, ShareSheet, WaitPanel } from "../../ui/result";
import { recordTrace } from "../../ui/trace";
import { sentence, VERDICT } from "../../ui/verdict";

const noClock = () => null;

export function ResultView({ tx, initial }: { tx: string; initial: Card | null }) {
  const site = useSite();
  const now = useNow();
  // a fresh transaction takes a few seconds to be indexed: asked again every 3 s until it is found
  const again = useRead<Card>(initial?.planted ? null : `/api/result?tx=${tx}`, 3000, 0);
  const c = again.data?.planted ? again.data : initial;
  const p = c?.planted ?? null;
  const fast = c?.record?.outcome === "Pending";
  const { read, a, b } = useDuel(p?.landed ? p.duel_id : null, c?.arena ?? "main", fast);
  const [share, setShare] = useState(false);
  const [fresh, setFresh] = useState(false);
  const seen = useRef<string | null>(null);
  const body = read.data;
  const d = body?.duel ?? null;
  const rec = (p?.index != null ? d?.chaos?.[p.index] : null) ?? c?.record ?? null;
  const outcome = rec?.outcome ?? null;
  const viewer = site.account && site.account === p?.signer ? "attacker" : "public";
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to the outcome changing, nothing else
  useEffect(() => {
    if (!rec || !outcome || !p) return;
    if (seen.current === "Pending" && outcome !== "Pending") {
      setFresh(true);
      site.announce(`${VERDICT[outcome as keyof typeof VERDICT].word}. ${sentence(rec, viewer) ?? ""}`);
    }
    seen.current = outcome;
    document.title = `${outcome === "Pending" ? "Waiting" : VERDICT[outcome].word} · Duel #${p.duel_id}`;
  }, [outcome, !!body]); // again once the duel is read: the page's own metadata title lands after the first run

  if (!c)
    return (
      <div className="page">
        <StatusBar kind="error" action={{ label: "Try again", run: () => location.reload() }}>
          Could not read from the chain.
        </StatusBar>
      </div>
    );
  if (!p)
    return (
      <div className="page stack">
        <p>{`No planted headline in transaction ${tx}.`}</p>
        <p className="t-small dim">
          A transaction sent in the last few seconds may not be readable yet. This page keeps looking.
        </p>
      </div>
    );
  if (!p.landed)
    return (
      <div className="page">
        <p>
          {`This attack did not land. The arena refused it${c.refused ? ": " : "."}`}
          {c.refused ? <span className="mono">{c.refused}</span> : null}
          {c.refused ? ". " : " "}
          No headline is shown for a refused attack.
        </p>
      </div>
    );
  const facts = (
    <dl className="facts sect">
      <dt>Duel</dt>
      <dd>
        <a href={duelPath(p.duel_id, c.arena)}>{`Duel #${p.duel_id}`}</a>
      </dd>
      <dt>Planted</dt>
      <dd className="mono">{p.at_ms ? `${new Date(p.at_ms).toISOString().slice(0, 10)} ${hm(p.at_ms)}` : "—"}</dd>
      <dt>By</dt>
      <dd className="mono">{shortId(p.signer, 16, 10)}</dd>
      <dt>Cost</dt>
      <dd>
        <Amount yocto={p.deposit} note={NETWORK_ID === "testnet"} />
      </dd>
      <dt />
      <dd>
        <a className="proof" href={verifyHref(p.duel_id, c.arena)}>
          Verify this result
        </a>
      </dd>
    </dl>
  );
  // the older arena keeps only the headline's hash and does not judge it: the headline, and no verdict word
  if (!rec)
    return (
      <div className="page stack">
        {c.text ? (
          <Headline text={c.text} />
        ) : (
          <p className="dim">The headline could not be read from the chain just now.</p>
        )}
        {p.headline === null ? <p>This arena records your headline but does not judge the result or pay out.</p> : null}
        {facts}
      </div>
    );
  const model = c.model ?? "the AI";
  const which = d && rec.target === d.b ? 1 : 0;
  const asWritten = body?.keyless?.[which]?.template === 1;
  const history = which === 0 ? a : b;
  const canShare = !!c.text && !c.hidden;
  return (
    <div className="page result-page">
      <Region read={read} skeleton={<Skeleton bars={["40%", "100%", "100%", "70%"]} />}>
        {(bd) =>
          bd.duel ? (
            rec.outcome === "Pending" ? (
              <WaitPanel
                c={rec}
                model={model}
                viewer={viewer}
                asWritten={asWritten}
                trace={recordTrace(rec, phaseOf(bd.duel, now) === "running" && !read.stale)}
                time={noClock}
                locked={p.index != null && bd.open?.[String(p.index)]?.open === false}
                decisionTimes={(history?.decisions ?? []).map((x) => x.at)}
                closeMs={nsMs(bd.duel.close_at)}
                now={now}
                link={`/i/${tx}`}
                plantedMs={nsMs(rec.at)}
              />
            ) : (
              <ResultPanel
                c={rec}
                model={model}
                viewer={viewer}
                asWritten={asWritten}
                end={endOf(bd.duel, rec.target, now)}
                feeBps={bd.config.chaos?.fee_bps ?? 0}
                reason={history?.said.find((s) => s.at > nsMs(rec.at))?.text ?? null}
                trace={recordTrace(rec)}
                time={noClock}
                fresh={fresh}
                actions={
                  <>
                    {viewer === "attacker" ? (
                      <Collect
                        records={bd.duel.chaos ?? []}
                        account={site.account}
                        contract={bd.contract}
                        duelId={p.duel_id}
                        finished={bd.duel.resolved}
                        onDone={read.retry}
                      />
                    ) : null}
                    {canShare ? (
                      <Button variant="quiet" onClick={() => setShare(true)}>
                        Share
                      </Button>
                    ) : null}
                  </>
                }
                links={
                  <>
                    <a className="proof" href={verifyHref(p.duel_id, c.arena)}>
                      Verify this result
                    </a>
                    <a href={duelPath(p.duel_id, c.arena, "attack=a")}>Plant another</a>
                  </>
                }
              />
            )
          ) : (
            <p>{`There is no duel #${p.duel_id} on ${NETWORK_ID}.`}</p>
          )
        }
      </Region>
      {facts}
      {canShare ? (
        <ShareSheet open={share} onClose={() => setShare(false)} tx={tx} model={model} outcome={rec.outcome} />
      ) : null}
    </div>
  );
}
