"use client";
// The Verify drawer: `?verify={duel id}` on any page opens it over that page (`keyless:{id}` for the keyless arena).
// It shows the lines of /api/verify, the same checks as `bun run verify-duel`, in four named groups. "Not checked"
// is never rounded up to passed, and an error never shows a partial green result.
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { addrHref } from "../tui";
import { type CheckGroup, type CheckLine, groupChecks } from "./board";
import { useSite } from "./chrome";
import { hm } from "./format";
import { Drawer, Skeleton, StatusBar, useRead } from "./kit";

type Body = {
  duel_id: string;
  status: "missing" | "open" | "checked";
  at?: number;
  arena?: string;
  counts?: Record<"PASS" | "FAIL" | "SKIP" | "INFO", number>;
  lines?: CheckLine[];
  degraded?: boolean;
  command: string;
};

const MARK = {
  PASS: ["✓", "proof", "passed"],
  FAIL: ["✕", "signal", "failed"],
  SKIP: ["▨", "caution", "not checked"],
  INFO: ["", "dim", ""],
} as const;
const GROUP_MARK = { pass: ["✓", "proof"], fail: ["✕", "signal"], skip: ["▨", "caution"] } as const;

function CheckRow({ l }: { l: CheckLine }) {
  const [mark, tone, word] = MARK[l.result];
  return (
    <li className="check-row">
      <span className={tone} aria-hidden="true">
        {mark}
      </span>
      <details open={l.result === "FAIL"}>
        <summary>
          {l.check}
          {word ? <span className={`sr-inline ${tone}`}>{` · ${word}`}</span> : null}
        </summary>
        <p className="t-mono dim">{l.detail}</p>
      </details>
    </li>
  );
}

function Group({ g }: { g: CheckGroup }) {
  const [mark, tone] = GROUP_MARK[g.mark];
  return (
    <details className="details check-group" open={g.mark !== "pass"}>
      <summary>
        <span className="t-label">{g.name}</span>
        <span className={`group-mark ${tone}`}>{mark}</span>
      </summary>
      <ul className="details-body">
        {g.lines.map((l) => (
          <CheckRow key={`${l.check}:${l.detail.slice(0, 40)}`} l={l} />
        ))}
      </ul>
    </details>
  );
}

function Self({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="sect stack-2">
      <h3 className="t-label">Check it yourself</h3>
      <div className="hrow">
        <code className="t-mono">{command}</code>
        <button
          type="button"
          className="btn-link end"
          onClick={() => navigator.clipboard.writeText(command).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="t-small dim">
        Runs the same checks on your machine from public sources. Sends nothing, spends nothing.
      </p>
    </section>
  );
}

export function VerifyDrawer() {
  const sp = useSearchParams();
  const { list } = useSite();
  const param = sp.get("verify");
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => setKey(param), [param]);
  const keyless = key?.startsWith("keyless:") ?? false;
  const id = key ? key.replace(/^keyless:/, "") : null;
  const ok = id !== null && /^\d{1,12}$/.test(id);
  // a cold check reads the duel's transactions and can take several seconds; asked again every 60 s while incomplete
  const read = useRead<Body>(ok ? `/api/${keyless ? "keyless/verify" : "verify"}?duel=${id}` : null, 60_000, 0);
  const close = () => {
    setKey(null);
    const u = new URL(location.href);
    u.searchParams.delete("verify"); // closing removes the parameter
    history.replaceState(null, "", u);
  };
  const v = read.data;
  const last = list.data?.duels.find(
    (r) => r.resolved && !r.cancelled && !(r.id === id && (r.arena === "keyless") === keyless),
  );
  const c = v?.counts;
  const groups = v?.lines ? groupChecks(v.lines) : [];
  return (
    <Drawer open={ok} onClose={close} title={`Verify duel #${id ?? ""}`}>
      {read.error ? (
        <StatusBar kind="error" action={{ label: "Try again", run: read.retry }}>
          {`Could not run the checks. ${read.error}`}
        </StatusBar>
      ) : !v ? (
        <div className="stack" aria-busy="true">
          <p>Collecting evidence from the chain…</p>
          <Skeleton rows={4} />
        </div>
      ) : v.status === "missing" ? (
        <p>{`There is no duel #${v.duel_id} on this arena.`}</p>
      ) : v.status === "open" ? (
        <div className="stack">
          <p>This duel is still running. The checks run when it ends.</p>
          <Self command={v.command} />
          {last ? (
            <a className="proof" href={`?verify=${last.arena === "keyless" ? "keyless%3A" : ""}${last.id}`}>
              Verify the last finished duel
            </a>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          {c ? (
            <p className="mono">
              <span>{`${c.PASS} passed`}</span> ·{" "}
              <span className={c.FAIL ? "signal" : undefined}>{`${c.FAIL} failed`}</span> ·{" "}
              <span>{`${c.SKIP} not checked`}</span>
            </p>
          ) : null}
          <p className="t-small dim">
            {`Checked ${v.at ? hm(v.at) : ""}, from public chain data`}{" "}
            <button type="button" className="btn-link" onClick={read.retry}>
              Check again
            </button>
          </p>
          {v.arena ? (
            <a href={addrHref(v.arena)} target="_blank" rel="noreferrer">
              See this duel's arena on the chain ↗
            </a>
          ) : null}
          {v.degraded ? (
            <StatusBar kind="info" action={{ label: "Check again", run: read.retry }}>
              Some chain data was not available yet. Affected checks read 'not checked'. Try again in a minute.
            </StatusBar>
          ) : null}
          <div>
            {groups.map((g) => (
              <Group key={g.name} g={g} />
            ))}
          </div>
          <Self command={v.command} />
        </div>
      )}
    </Drawer>
  );
}
