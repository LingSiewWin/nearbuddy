// Terminal-UI primitives shared by /arena and /agent: fixed-width boxes, rows, bars and links drawn with
// box-drawing characters inside a <pre>, btop-style (numbered box titles, block-character bars).
// Every line is exactly W characters wide; on narrow screens the <pre> scrolls sideways (globals.css).
import type { ReactNode } from "react";

export const W = 112;
const KEY = 16;             // label column
const VW = W - KEY - 5;     // value column: W minus "│ ", label, " ", " │"
export const NEAR = 10n ** 24n;
export const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export const near = (y: string | null | undefined, d = 3) => {
  if (!y) return "-";
  const v = BigInt(y); const f = ((v % NEAR) * 10n ** BigInt(d)) / NEAR;
  return `${v / NEAR}.${f.toString().padStart(d, "0")}`;
};
export const short = (s: string | null | undefined, n = 10) => (s ? `${s.slice(0, n)}…` : "-");
export const ts = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(11, 19);
export const price8 = (p: string | number | null | undefined) => (p == null ? "-" : (Number(p) / 1e8).toFixed(4));
export const bps = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

const label = (k: string) => k.padEnd(KEY).slice(0, KEY);
export const row = (k: string, v: string) => `│ ${label(k)} ${v.padEnd(VW).slice(0, VW)} │`;
export const top = (t: string) => `┌─ ${t} ${"─".repeat(Math.max(0, W - t.length - 5))}┐`;
export const bottom = () => `└${"─".repeat(W - 2)}┘`;

/** btop-style box title: a coloured index digit, the name, then the rule. */
export const boxTitle = (n: number, name: string, extra = ""): ReactNode => {
  const text = `${n}${name}${extra ? ` ${extra}` : ""}`;
  return <>{"┌─"}<span className="num">{n}</span><span className="hi">{name}</span>{extra ? <span className="dim">{` ${extra}`}</span> : ""}{" "}{"─".repeat(Math.max(0, W - text.length - 4))}{"┐"}</>;
};

/** One coloured/linked piece of a row value. Plain strings are uncoloured text. */
export type Cell = string | { t: string; c?: string; href?: string; title?: string };

/** `row()` whose value is built from cells; padding and border stay exact, overflow is cut. */
export const rowx = (k: string | Cell, cells: Cell[], kc?: string): ReactNode => {
  let left = VW;
  const out: ReactNode[] = [];
  const ko = typeof k === "string" ? { t: k } : k;
  const kt = ko.t.slice(0, KEY); const kpad = " ".repeat(KEY - kt.length);
  const key = ko.href ? <><a className={ko.c ?? kc ?? "hi"} href={ko.href} title={ko.title}>{kt}</a>{kpad}</> : kc ? <span className={kc}>{label(ko.t)}</span> : label(ko.t);
  cells.forEach((cell, i) => {
    const o = typeof cell === "string" ? { t: cell } : cell;
    const t = o.t.slice(0, Math.max(0, left)); left -= t.length;
    if (!t) return;
    if (o.href) out.push(<a key={i} className={o.c ?? "hi"} href={o.href} title={o.title} target={o.href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{t}</a>);
    else if (o.c || o.title) out.push(<span key={i} className={o.c} title={o.title}>{t}</span>);
    else out.push(t);
  });
  return <>{"│ "}{key}{" "}{out}{" ".repeat(Math.max(0, left))}{" │"}</>;
};

/** A block-character bar: `frac` of `width` filled. */
export const bar = (frac: number, width = 30) => {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
};

/** Stacked bar as row cells: each [count, class] segment coloured, the unfilled rest dim. Spread into rowx. */
export const meter = (parts: [number, string][], total: number, width = 30): Cell[] => {
  let used = 0; let acc = 0;
  const segs: Cell[] = [];
  for (const [n, c] of parts) {
    acc += n;
    const end = total ? Math.round((acc / total) * width) : 0;
    const len = Math.max(0, end - used); used = end;
    if (len) segs.push({ t: "█".repeat(len), c });
  }
  segs.push({ t: "░".repeat(Math.max(0, width - used)), c: "dim" });
  return segs;
};

export const explorer = (net: "testnet" | "mainnet" = "testnet") => (net === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io");
export const txHref = (tx: string, net?: "testnet" | "mainnet") => `${explorer(net)}/txns/${tx}`;
export const addrHref = (acct: string, net?: "testnet" | "mainnet") => `${explorer(net)}/address/${acct}`;
export const agentHref = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
export const duelHref = (id: string | number) => `/duel/${id}`;
export const blockHref = (height: string, net?: "testnet" | "mainnet") => `${explorer(net)}/blocks/${height}`;

/** `row()` with a tx hash rendered as a nearblocks link; padding and border stay intact. */
export const linkRow = (k: string, before: string, tx: string, after: string, net: "testnet" | "mainnet" = "testnet"): ReactNode =>
  rowx(k, [before, { t: short(tx, 10), href: txHref(tx, net), title: tx }, after]);
