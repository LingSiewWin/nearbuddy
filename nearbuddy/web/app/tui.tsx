// Terminal-UI primitives shared by /arena and /agent: fixed-width boxes, rows, bars and links drawn with
// box-drawing characters inside a <pre>, btop-style (numbered box titles, block-character bars).
import type { ReactNode } from "react";

export const W = 112;
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

export const row = (k: string, v: string) => `│ ${k.padEnd(16)} ${v.padEnd(W - 20).slice(0, W - 20)} │`;
export const top = (t: string) => `┌─ ${t} ${"─".repeat(Math.max(0, W - t.length - 5))}┐`;
export const bottom = () => `└${"─".repeat(W - 2)}┘`;

/** btop-style box title: a coloured index digit, the name, then the rule. */
export const boxTitle = (n: number, name: string, extra = ""): ReactNode => {
  const text = `${n}${name}${extra ? ` ${extra}` : ""}`;
  return <>{"┌─"}<span className="warn">{n}</span><span className="hi">{name}</span>{extra ? ` ${extra}` : ""}{" "}{"─".repeat(Math.max(0, W - text.length - 4))}{"┐"}</>;
};

/** A block-character bar: `frac` of `width` filled. */
export const bar = (frac: number, width = 30) => {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
};

/** `row()` with a tx hash rendered as a nearblocks link; padding and border stay intact. */
export const linkRow = (k: string, before: string, tx: string, after: string, net: "testnet" | "mainnet" = "testnet"): ReactNode => {
  const label = short(tx, 10);
  const line = row(k, `${before}${label}${after}`);
  const i = line.indexOf(label);
  const host = net === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";
  return i < 0 ? <>{line}</> : <>{line.slice(0, i)}<a className="hi" href={`${host}/txns/${tx}`} target="_blank" rel="noreferrer">{label}</a>{line.slice(i + label.length)}</>;
};

export const agentHref = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
