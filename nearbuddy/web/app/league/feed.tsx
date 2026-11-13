// The feed beside the stage: what each model said and the paid shouts planted at it, newest at the bottom. Every
// string here came from a model or a stranger: it is rendered as text, never as markup.
import { type ReactNode, useEffect, useRef } from "react";
import type { Comment } from "../lib/comments";
import type { FeedLine } from "../lib/feed";

const OUTCOME: Record<string, string> = {
  Pending: "",
  Flipped: "took the bait",
  Held: "held",
  NoTrial: "no trial",
  Expired: "expired",
};

/** One feed entry with its time in ms, so chain lines (ns) and comments (ms) sort together. */
type Entry = { t: number; key: string; line?: FeedLine; comment?: Comment };

export function Feed({
  lines,
  comments = [],
  children,
}: {
  lines: FeedLine[];
  comments?: Comment[];
  children?: ReactNode;
}) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const entries: Entry[] = [
    ...lines.map((l, i): Entry => ({ t: Number(BigInt(l.at) / 1_000_000n), key: `l${i}:${l.at}`, line: l })),
    ...comments.map((c): Entry => ({ t: c.at, key: `c${c.id}`, comment: c })),
  ].sort((x, y) => x.t - y.t);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when an entry arrives
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return (
    <section id="feed" className="panel feed" aria-labelledby="feed-h">
      <h2 id="feed-h">
        FEED <span>models, shouts and chat</span>
      </h2>
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {entries.length === 0 ? <li className="dim">nothing said yet</li> : null}
        {entries.map(({ key, line: l, comment: c }) =>
          c ? (
            <li key={key}>
              <span className="dim">{c.by}</span> {c.text}
            </li>
          ) : l?.kind === "model" ? (
            <li key={key} className="model">
              <span className="hi">{l.model}</span>{" "}
              {l.side ? <span className={l.side === "Long" ? "win" : "loss"}>{l.side.toUpperCase()}</span> : null}{" "}
              {l.text}
            </li>
          ) : l ? (
            <li key={key}>
              <span className="tag warn">SHOUT</span> <span className="dim">{`${l.by} at ${l.target}`}</span>{" "}
              {l.text ?? "(headline not published)"}{" "}
              {OUTCOME[l.outcome] ? <span className="tag">{OUTCOME[l.outcome]}</span> : null}
            </li>
          ) : null,
        )}
      </ol>
      {children}
    </section>
  );
}
