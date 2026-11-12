// The feed beside the stage: what each model said and the paid shouts planted at it, newest at the bottom. Every
// string here came from a model or a stranger: it is rendered as text, never as markup.
import { useEffect, useRef } from "react";
import type { FeedLine } from "../lib/feed";

const OUTCOME: Record<string, string> = {
  Pending: "",
  Flipped: "took the bait",
  Held: "held",
  NoTrial: "no trial",
  Expired: "expired",
};

export function Feed({ lines }: { lines: FeedLine[] }) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <section id="feed" className="panel feed" aria-labelledby="feed-h">
      <h2 id="feed-h">
        FEED <span>models and shouts</span>
      </h2>
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? <li className="dim">nothing said yet</li> : null}
        {lines.map((l) =>
          l.kind === "model" ? (
            <li key={`m${l.tx}`} className="model">
              <span className="hi">{l.model}</span>{" "}
              {l.side ? <span className={l.side === "Long" ? "win" : "loss"}>{l.side.toUpperCase()}</span> : null}{" "}
              {l.text}
            </li>
          ) : (
            <li key={`s${l.index}`}>
              <span className="tag warn">SHOUT</span> <span className="dim">{`${l.by} at ${l.target}`}</span>{" "}
              {l.text ?? "(headline not published)"}{" "}
              {OUTCOME[l.outcome] ? <span className="tag">{OUTCOME[l.outcome]}</span> : null}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
