// Words and numbers as the Trace design prints them (docs: plain words, honest numbers). Pure: no clock, no DOM.

export type Side = "Long" | "Short";
/** A bet in the page's words: never "long" or "short". */
export const bet = (s: Side): "UP" | "DOWN" => (s === "Long" ? "UP" : "DOWN");
export const other = (s: Side): Side => (s === "Long" ? "Short" : "Long");

const YOCTO = 24;

/** A yoctoNEAR amount in NEAR: up to 4 decimals, rounded to nearest, trailing zeros dropped ("0.05", "0.1563", "2").
 *  An amount under 0.0001 keeps its first two significant digits instead of printing as 0 ("0.000041"). */
export function nearAmount(yocto: string | bigint): string {
  const v = BigInt(yocto);
  if (v <= 0n) return "0";
  const zeros = YOCTO - v.toString().length; // zeros between the point and the first digit; negative from 1 NEAR up
  const places = zeros >= 4 ? Math.min(YOCTO, zeros + 2) : 4;
  const unit = 10n ** BigInt(YOCTO - places);
  const q = (v + unit / 2n) / unit;
  const scale = 10n ** BigInt(places);
  const frac = (q % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${q / scale}.${frac}` : `${q / scale}`;
}

/** The unit follows the number: "0.05 NEAR". */
export const near = (yocto: string | bigint) => `${nearAmount(yocto)} NEAR`;
export const TEST_NOTE = "test NEAR, no real value";

/** Time left or elapsed: "mm:ss" under an hour, "h:mm:ss" from one hour up. Negative reads as zero. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return s < 3600
    ? `${p(Math.floor(s / 60))}:${p(s % 60)}`
    : `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** A wall-clock time, "14:06". The time zone is the reader's unless one is given (tests give UTC). */
export const hm = (ms: number, timeZone?: string) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });

/** "3 min ago", "2 h ago", "4 d ago"; "just now" under a minute. */
export function timeAgo(ms: number, now: number): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

/** A long account or key cut in the middle so both ends stay readable. */
export const shortId = (s: string, head = 10, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

/** "Guest · k3f9": the first four characters of the random part of a guest account's name. */
export const guestLabel = (account: string) => `Guest · ${account.replace(/^nb-guest-/, "").slice(0, 4)}`;

/** ns timestamp (a contract string) in ms. */
export const nsMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

/** An oracle price (8 decimals) as a number, or null. */
export const price8 = (p: string | null | undefined) => (p && p !== "0" ? Number(p) / 1e8 : null);

/** A model id as the screens print it: its last path segment ("Qwen/Qwen3.8-27B" reads "Qwen3.8-27B"). The full id
 *  stays available as the element's title. */
export const shortModel = (id: string) => id.split("/").pop() || id;
/** "11:07:28" in UTC: a recorded time, the same for every reader. */
export const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 19);
