// Plain-language formatting shared by the pages: who a model is, its prompt, signed percents, NEAR, prices,
// clocks. One place so every page says the same thing the same way.
import { NET, NETWORK_ID, NETWORKS, type NetworkId } from "../network";

const MINUS = "−";

/** "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek", "Qwen/Qwen3.8-27B" -> "Qwen". */
/** The family with an attached version, so two generations live at once stay apart:
 *  "Qwen/Qwen3.8-27B" -> "Qwen3.8", "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek", "z-ai/glm-5.3" -> "GLM". */
export const who = (model: string | null | undefined) => {
  const base = (model ?? "").split("/").pop() ?? "";
  const m = base.match(/^([A-Za-z]+)(\d[\d.]*\d|\d)?/);
  if (!m) return base || "unknown";
  const family = (m[1] as string).length <= 3 ? (m[1] as string).toUpperCase() : (m[1] as string);
  return family + (m[2] ?? "");
};
/** "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek-V4.1-Flash". */
export const modelName = (model: string | null | undefined) =>
  ((model ?? "").split("/").pop() ?? "").replace(/-\d{4}$/, "");
/** Identity colour class: one colour per model family, red is never one of them (red means attack). */
export const tone = (model: string | null | undefined) => {
  const m = (model ?? "").toLowerCase();
  return m.includes("qwen") ? "k-qwen" : m.includes("deepseek") ? "k-deep" : "k-other";
};
const ARMS: Record<string, string> = {
  naive: "plain prompt",
  hardened: "guarded prompt",
  A: "guard A (marked channels)",
  B: "guard B",
  C: "guard C (evidence rule)",
};
export const promptName = (arm: string | null | undefined) => (arm ? (ARMS[arm] ?? arm) : "prompt unknown");

export const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(d)}`;
export const pct = (n: number, d = 2) => `${signed(n, d)}%`;
export const near = (n: number, d = 3) => `${Number(n.toFixed(d))} NEAR`;
export const usd = (n: number | null | undefined, d = 4) => (n == null ? "–" : `$${n.toFixed(d)}`);
export const mmss = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
/** Local wall-clock time with milliseconds, for the tape. */
export const clock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return [`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, `.${p(d.getMilliseconds(), 3)}`] as const;
};
export const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
export const sideWord = (side: "Long" | "Short" | null | undefined) =>
  side === "Long" ? "betting up" : side === "Short" ? "betting down" : "yet to make a call";
export const stake = (sizePct: number | null | undefined) =>
  sizePct == null
    ? ""
    : sizePct >= 100
      ? "all its stake"
      : sizePct === 50
        ? "half its stake"
        : `${sizePct}% of its stake`;
export const shortKey = (pk: string) => pk.slice(0, 4);
/** Explorer links on this build's network (NEAR_NETWORK, app/network.ts); historic testnet proofs pass "testnet". */
export const txUrl = (tx: string, net: NetworkId = NETWORK_ID) => `${NETWORKS[net].explorer}/txns/${tx}`;
export const acctUrl = (a: string, net: NetworkId = NETWORK_ID) => `${NETWORKS[net].explorer}/address/${a}`;
/** "NEAR testnet" or "NEAR mainnet": the chain every page reads. */
export const CHAIN = `NEAR ${NETWORK_ID}`;
/** A placeholder account on this network, for copy-paste commands. */
export const YOU = NETWORK_ID === "mainnet" ? "<you.near>" : "<you.testnet>";
export { NETWORK_ID };
/** A NEAR account for a sentence: named accounts as they are, 64-hex implicit accounts shortened. */
export const account = (a: string) => (a.length > 40 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
/** yoctoNEAR (a u128 string) to NEAR, 4 decimals. */
export const yoctoNear = (y: string) => Number((Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4));
export const agentHref = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
export const duelHref = (id: number | string) => `/duel/${id}`;
/** The team's own test agents: stubs ("stub/…", "redteam/stub", the rule in cells.ts) and red-team registrations
 *  ("redteam/…", some with an enclave key). Kept off the standings, the hero and the sitemap; /terminal lists them. */
/** "stub" as a whole model-id segment: isStubModel in cells.ts, kept here so pages do not pull in the terminal UI. */
export const isStubModel = (model: string) => /(^|\/)stub(\/|$)/.test(model);
export const isTestAgent = (model: string) => isStubModel(model) || model.startsWith("redteam/");
export const ARENA_ID = NET.arena;
export const ORACLE_ID = NET.oracle;
/** A flipped-byte proof the arena refused on testnet (README): link it with txUrl(TAMPER_TX, "testnet"). */
export const TAMPER_TX = "4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt";
