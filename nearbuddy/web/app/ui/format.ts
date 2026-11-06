// Plain-language formatting shared by the pages: who a model is, its prompt, signed percents, NEAR, prices,
// clocks. One place so every page says the same thing the same way.
const MINUS = "−";

/** "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek", "Qwen/Qwen3.8-27B" -> "Qwen". */
export const who = (model: string | null | undefined) => {
  const base = (model ?? "").split("/").pop() ?? "";
  return base.match(/^[A-Za-z]+/)?.[0] ?? (base || "unknown");
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
export const txUrl = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;
export const acctUrl = (a: string) => `https://testnet.nearblocks.io/address/${a}`;
/** A NEAR account for a sentence: named accounts as they are, 64-hex implicit accounts shortened. */
export const account = (a: string) => (a.length > 40 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
/** yoctoNEAR (a u128 string) to NEAR, 4 decimals. */
export const yoctoNear = (y: string) => Number((Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4));
export const agentHref = (pk: string) => `/agent/${encodeURIComponent(pk)}`;
export const duelHref = (id: number | string) => `/duel/${id}`;
export const ARENA_ID = "arena.nearbuddy-solver.testnet";
export const TAMPER_TX = "4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt";
