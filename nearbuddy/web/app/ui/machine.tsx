"use client";
// The machine form of a panel: its endpoint, what it returns, a curl line for this host, and a trimmed live
// sample fetched only while the agent view is on.
import { useEffect, useState } from "react";
import { useView } from "./view";

const trim = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v))
    return v.length > 2
      ? [...v.slice(0, 2).map((x) => trim(x, depth + 1)), `… ${v.length - 2} more`]
      : v.map((x) => trim(x, depth + 1));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 3 ? "…" : trim(x, depth + 1)]));
  if (typeof v === "string" && v.length > 140) return `${v.slice(0, 140)}…`;
  return v;
};

/** JSON with keys dimmed; a regex over the pretty-printed text, no parser. */
function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(trim(value), null, 2);
  const parts = text.split(/("(?:[^"\\]|\\.)*"|-?\d+\.?\d*(?:e[+-]?\d+)?|true|false|null)/g);
  let off = 0;
  const cls = parts.map((p) => {
    const at = off;
    off += p.length;
    if (p.startsWith('"')) return text[at + p.length] === ":" ? "k" : "s";
    return /^(-?\d|true|false|null)/.test(p) ? "n" : "p";
  });
  return (
    <pre className="json">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens of one string
        <span key={i} className={cls[i]}>
          {p}
        </span>
      ))}
    </pre>
  );
}

export function Machine({
  method = "GET",
  path,
  note,
  desc,
  sample = path,
  stream = false,
  once = false,
}: {
  method?: "GET" | "SSE";
  path: string;
  note?: string;
  desc: string;
  sample?: string | null;
  stream?: boolean;
  once?: boolean; // the answer never changes (a resolved duel's re-check): fetch it once, do not poll
}) {
  const view = useView();
  const [origin, setOrigin] = useState("");
  const [data, setData] = useState<unknown>(null);
  useEffect(() => setOrigin(location.origin), []);
  useEffect(() => {
    if (view !== "agent" || !sample || stream) return;
    let alive = true;
    const get = () =>
      fetch(sample)
        .then((r) => r.json())
        .then((j) => alive && setData(j))
        .catch(() => {});
    get();
    const id = once ? undefined : setInterval(get, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [view, sample, stream, once]);
  return (
    <div className="m">
      <div className="ep">
        <b>{method}</b>
        <code>{path}</code>
        {note ? <span>{note}</span> : null}
      </div>
      <p className="mdesc">{desc}</p>
      <pre className="curl">{`curl -s${stream ? "N" : ""} ${origin}${path}`}</pre>
      {data ? <Json value={data} /> : sample && !stream ? <p className="mdesc">loading a live sample…</p> : null}
    </div>
  );
}
