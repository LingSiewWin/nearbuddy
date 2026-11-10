// Terminal-UI primitives shared by /arena, /agent and /duel: fixed-width boxes, rows, bars and links drawn
// with box-drawing characters inside a <pre>, btop-style (numbered box titles, block-character bars).
// Every line is exactly W characters wide. Under 600 px (globals.css) a row drops its borders and padding and reflows
// as "label value" text wrapping at words, and box rules clip at the screen edge, so nothing breaks mid-column.
import type { ReactNode } from "react";
import { NETWORK_ID, NETWORKS, type NetworkId } from "./network";

// Client components read NEXT_PUBLIC_NEAR_NETWORK, derived from NEAR_NETWORK in next.config.ts; see network.ts.
export { NET, NETWORK_ID } from "./network";

export const W = 112;
const KEY = 16; // label column
const VW = W - KEY - 5; // value column: W minus "│ ", label, " ", " │"
export const NEAR = 10n ** 24n;
export const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const TAMPER_TX = "4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt"; // flipped-byte proof refused on testnet (README); linked to testnet on every network

export const near = (y: string | null | undefined, d = 3) => {
  if (!y) return "-";
  const v = BigInt(y);
  const f = ((v % NEAR) * 10n ** BigInt(d)) / NEAR;
  return `${v / NEAR}.${f.toString().padStart(d, "0")}`;
};
export const short = (s: string | null | undefined, n = 10) => (s ? `${s.slice(0, n)}…` : "-");
export const ts = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(11, 19);
export const price8 = (p: string | number | null | undefined) => (p == null ? "-" : (Number(p) / 1e8).toFixed(4));
export const bps = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
/** "m:ss" until a ns timestamp, or null once it has passed. */
export const countdown = (ns: string, nowMs: number) => {
  const s = Math.floor((Number(BigInt(ns) / 1_000_000n) - nowMs) / 1000);
  return s <= 0 ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** One coloured/linked piece of a row. Plain strings are uncoloured text; `onClick` renders a button. */
export type Cell =
  | string
  | { t: string; c?: string | undefined; href?: string | undefined; title?: string | undefined; onClick?: () => void };

/** Renders cells into at most `width` characters; returns the nodes and the characters used. */
const cells = (list: Cell[], width: number, dc?: string): [ReactNode[], number] => {
  let left = width;
  const out: ReactNode[] = [];
  list.forEach((cell, i) => {
    const o = typeof cell === "string" ? { t: cell } : cell;
    const t = o.t.slice(0, Math.max(0, left));
    left -= t.length;
    if (!t) return;
    // cells are positional fragments of one fixed-width line, never reordered: the index is the identity
    if (o.href)
      out.push(
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
          key={i}
          className={o.c ?? dc ?? "hi"}
          href={o.href}
          title={o.title}
          target={o.href.startsWith("/") ? undefined : "_blank"}
          rel="noreferrer"
        >
          {t}
        </a>,
      );
    else if (o.onClick)
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
        <button key={i} type="button" className={`lnk ${o.c ?? "hi"}`} onClick={o.onClick} title={o.title}>
          {t}
        </button>,
      );
    else if (o.c || o.title)
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
        <span key={i} className={o.c} title={o.title}>
          {t}
        </span>,
      );
    else out.push(t);
  });
  return [out, width - left];
};

/** A row: label column (string or cells) then value cells; padding and border stay exact, overflow is cut. */
export const rowx = (k: string | Cell | Cell[], v: Cell[], kc?: string): ReactNode => {
  const ks = Array.isArray(k) ? k : [typeof k === "string" ? { t: k, c: kc } : { c: kc, ...k }];
  const [key, ku] = cells(ks, KEY, kc);
  const [val, vu] = cells(v, VW);
  return (
    <span className="r">
      <span className="pad">{"│ "}</span>
      <span className="k">
        {key}
        {" ".repeat(KEY - ku)}
      </span>{" "}
      <span className="v">{val}</span>
      <span className="pad">
        {" ".repeat(VW - vu)}
        {" │"}
      </span>
    </span>
  );
};
export const row = (k: string, v: string) => rowx(k, [v]);
/** Dim explanation rows at the bottom of a box: "term = five words · term = …", packed into as many rows as fit. */
export const legend = (t: string): ReactNode => {
  const lines: string[] = [];
  for (const part of t.split(" · ")) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} · ${part}`.length <= VW) lines[last] = `${lines[last]} · ${part}`;
    else lines.push(part);
  }
  return (
    <>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: legend rows are positional text
        <span key={i}>
          {i ? "\n" : ""}
          {rowx({ t: i ? "" : "legend", c: "dim" }, [{ t: l, c: "dim" }])}
        </span>
      ))}
    </>
  );
};

/** btop-style box title: a coloured index digit, the name (linked when `href`), then the rule. */
export const boxTitle = (n: number, name: string, extra = "", href?: string): ReactNode => {
  const text = `${n}${name}${extra ? ` ${extra}` : ""}`;
  return (
    <span className="rule">
      {"┌─"}
      <span className="num">{n}</span>
      {href ? (
        <a className="hi" href={href}>
          {name}
        </a>
      ) : (
        <span className="hi">{name}</span>
      )}
      {extra ? <span className="dim">{` ${extra}`}</span> : ""} {"─".repeat(Math.max(0, W - text.length - 4))}
      {"┐"}
    </span>
  );
};
/** Divider inside a box: `├─ cells ──┤`. */
export const rule = (v: Cell[]): ReactNode => {
  const [out, used] = cells(v, W - 6);
  return (
    <span className="rule">
      {"├─ "}
      {out} {"─".repeat(W - 5 - used)}
      {"┤"}
    </span>
  );
};
export const bottom = (): ReactNode => <span className="rule">{`└${"─".repeat(W - 2)}┘`}</span>;

/** A block-character bar: `frac` of `width` filled. */
export const bar = (frac: number, width = 30) => {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
};

/** Stacked bar as row cells: each [count, class] segment coloured, the unfilled rest dim. Spread into rowx. */
export const meter = (parts: [number, string][], total: number, width = 30): Cell[] => {
  let used = 0;
  let acc = 0;
  const segs: Cell[] = [];
  for (const [n, c] of parts) {
    acc += n;
    const end = total ? Math.round((acc / total) * width) : 0;
    const len = Math.max(0, end - used);
    used = end;
    if (len) segs.push({ t: "█".repeat(len), c });
  }
  segs.push({ t: "░".repeat(Math.max(0, width - used)), c: "dim" });
  return segs;
};

const explorer = (net: NetworkId = NETWORK_ID) => NETWORKS[net].explorer;
export const txHref = (tx: string, net?: NetworkId) => `${explorer(net)}/txns/${tx}`;
export const addrHref = (acct: string, net?: NetworkId) => `${explorer(net)}/address/${acct}`;
export const agentHref = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
export const duelHref = (id: string | number) => `/duel/${id}`;
export const blockHref = (height: string, net?: NetworkId) => `${explorer(net)}/blocks/${height}`;
export const REPO = "https://github.com/LingSiewWin/nearbuddy";

/** `row()` with a tx hash rendered as a nearblocks link; padding and border stay intact. */
export const linkRow = (k: string, before: string, tx: string, after: string, net: NetworkId = NETWORK_ID): ReactNode =>
  rowx(k, [before, { t: short(tx, 10), href: txHref(tx, net), title: tx }, after]);

/** JSON from one of our api routes; a non-JSON body (a framework 500 page) or an `error` field becomes a short Error. */
export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!(r.headers.get("content-type") ?? "").includes("json")) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as T & { error?: string };
  if (j.error) throw new Error(j.error);
  return j;
}
