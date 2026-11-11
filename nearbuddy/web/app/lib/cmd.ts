// The terminal's command language: parse one line, complete the word under the cursor, and the list the empty
// palette and `help` show. Pure, so bun test covers it; the page maps a parsed command to what it does.
import type { Pick } from "./abi/predict";
import type { Direction } from "./inject";

export type Target = "A" | "B";
export type Cmd =
  | { k: "watch" }
  | { k: "duel"; id: string }
  | { k: "agent"; who: string }
  | { k: "inject"; duel: string; side: Target; kind: Direction | null; text: string }
  | { k: "claim"; duel: string }
  | { k: "claimPredictions" }
  | { k: "predict"; duel: string; index: number | null; pick: Pick }
  | { k: "settle"; duel: string }
  | { k: "verify"; duel: string }
  | { k: "connect" }
  | { k: "disconnect" }
  | { k: "help" }
  | { k: "copy" };
export type Parsed = Cmd | { k: "error"; msg: string };

/** Every command once, in menu order: the empty palette lists these, and clicking one types its `fill`. */
export const COMMANDS = [
  { name: "watch", args: "", fill: "watch", what: "follow the live duel" },
  {
    name: "predict",
    args: "<duel> [attack] <A|B|fooled|holds>",
    fill: "predict ",
    what: "no stake: say who wins a duel, or whether an attack fools its model; deposit back once scored",
  },
  {
    name: "inject",
    args: '<duel> <A|B> [long|short] "<headline>"',
    fill: "inject ",
    what: "plant a fake headline in one model; long|short is the side the lie pushes",
  },
  { name: "duel", args: "<id>", fill: "duel ", what: "show one duel in pane 2" },
  { name: "agent", args: "<model|pk>", fill: "agent ", what: "open a model's full record" },
  { name: "verify", args: "<duel>", fill: "verify ", what: "check a duel's proofs yourself" },
  {
    name: "claim",
    args: "<duel|predictions>",
    fill: "claim ",
    what: "collect what your headlines earned in a finished duel, or your prediction deposits",
  },
  { name: "settle", args: "<duel>", fill: "settle ", what: "score the predictions on a duel whose answers are in" },
  { name: "connect", args: "", fill: "connect", what: "connect a NEAR testnet wallet" },
  { name: "copy", args: "", fill: "copy", what: "copy the link to what you are looking at" },
  { name: "help", args: "", fill: "help", what: "keys, commands and what every word means" },
] as const;
const NAMES: readonly string[] = [...COMMANDS.map((c) => c.name), "disconnect"];

const ID_RE = /^(0|[1-9]\d{0,11})$/;
/** The predict contract's bound: 32 attacks per duel, numbered from 0 as pane 2 and `get_chaos` list them. */
const MAX_ATTACK = 31;
const PICKS = new Map<string, Pick>([
  ["a", "A"],
  ["b", "B"],
  ["tie", "Tie"],
  ["fooled", "Flipped"],
  ["flipped", "Flipped"],
  ["holds", "Held"],
  ["held", "Held"],
]);
const DIRS = new Map<string, Direction>([
  ["long", "Long"],
  ["short", "Short"],
]);
/** Words split on spaces; a double-quoted run is one word, quotes dropped. An unclosed quote runs to the end. */
export const words = (line: string): string[] => {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"?|(\S+)/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
};

export function parse(line: string): Parsed {
  const w = words(line.trim().replace(/^:/, ""));
  const [name = "", a, b] = w;
  const id = (x: string | undefined, what: string): Parsed | string =>
    x && ID_RE.test(x.replace(/^#/, "")) ? x.replace(/^#/, "") : { k: "error", msg: `${what} needs a duel number` };
  switch (name.toLowerCase()) {
    case "":
      return { k: "error", msg: "type a command, or pick one from the list" };
    case "watch":
    case "connect":
    case "disconnect":
    case "help":
    case "copy":
      return { k: name.toLowerCase() as "watch" };
    case "?":
      return { k: "help" };
    case "duel":
    case "verify":
    case "settle":
    case "claim": {
      const n = name.toLowerCase() as "duel" | "verify" | "settle" | "claim";
      if (n === "claim" && a?.toLowerCase() === "predictions") return { k: "claimPredictions" };
      const d = id(a, n);
      if (typeof d !== "string") return d;
      return n === "duel" ? { k: "duel", id: d } : { k: n, duel: d };
    }
    case "predict": {
      const d = id(a, "predict");
      if (typeof d !== "string") return d;
      const attack = w.length > 3 ? (b ?? "").replace(/^#/, "") : null;
      const pick = PICKS.get((w[attack === null ? 2 : 3] ?? "").toLowerCase());
      if (attack !== null && !(/^\d{1,2}$/.test(attack) && Number(attack) <= MAX_ATTACK))
        return { k: "error", msg: `predict needs an attack number from 0 to ${MAX_ATTACK}` };
      const index = attack === null ? null : Number(attack);
      if (!pick || (index === null) !== (pick === "A" || pick === "B" || pick === "Tie"))
        return {
          k: "error",
          msg:
            index === null
              ? "predict needs a winner: predict 12 A, or an attack: predict 12 0 fooled"
              : "predict an attack fooled or holds",
        };
      return { k: "predict", duel: d, index, pick };
    }
    case "agent":
      return a ? { k: "agent", who: a } : { k: "error", msg: "agent needs a model name or key" };
    case "inject": {
      const d = id(a, "inject");
      if (typeof d !== "string") return d;
      const side = b?.toUpperCase();
      if (side !== "A" && side !== "B") return { k: "error", msg: "inject needs a side: A or B" };
      // an optional long|short before the headline: the side the lie pushes (deploy 17 needs it)
      const dir = w.length > 4 ? DIRS.get((w[3] ?? "").toLowerCase()) : undefined;
      const text = w
        .slice(dir ? 4 : 3)
        .join(" ")
        .trim();
      if (!text) return { k: "error", msg: 'inject needs a headline in quotes: inject 12 B short "..."' };
      return { k: "inject", duel: d, side, kind: dir ?? null, text };
    }
    default:
      return { k: "error", msg: `unknown command "${name}": type help` };
  }
}

/** What Tab can fill in: open and recent duel ids, model names and agent keys. */
export type Known = { duels: string[]; agents: string[] };

/** Tab: the line with its last word completed to the longest prefix every candidate shares, and the candidates. */
export function complete(line: string, known: Known): { line: string; options: string[] } {
  const w = words(line);
  const atNew = line === "" || line.endsWith(" ");
  const i = atNew ? w.length : w.length - 1;
  const word = atNew ? "" : (w[i] ?? "");
  const cmd = (w[0] ?? "").toLowerCase();
  const pool =
    i === 0
      ? NAMES
      : i === 1 && (cmd === "duel" || cmd === "verify" || cmd === "inject" || cmd === "predict" || cmd === "settle")
        ? known.duels
        : i === 1 && cmd === "claim"
          ? [...known.duels, "predictions"]
          : i === 1 && cmd === "agent"
            ? known.agents
            : i === 2 && (cmd === "inject" || cmd === "predict")
              ? ["A", "B"]
              : i === 3 && cmd === "inject"
                ? ["long", "short"]
                : i === 3 && cmd === "predict"
                  ? ["fooled", "holds"]
                  : [];
  const options = [...new Set(pool)].filter((o) => o.toLowerCase().startsWith(word.toLowerCase()));
  if (!options.length) return { line, options };
  let pre = options[0]!;
  for (const o of options) while (!o.toLowerCase().startsWith(pre.toLowerCase())) pre = pre.slice(0, -1);
  const done = options.length === 1;
  const head = atNew ? line : line.slice(0, line.length - word.length);
  const filled = pre.length >= word.length ? pre : word;
  return { line: `${head}${filled}${done ? " " : ""}`, options: done ? [] : options };
}

/** The command line a prediction button stands for: `predict 480 A`, or `predict 480 1 fooled` for attack 1. */
export const predictLine = (duel: string, index: number | null, pick: Pick) =>
  `predict ${duel}${index === null ? "" : ` ${index}`} ${pick === "Flipped" ? "fooled" : pick === "Held" ? "holds" : pick === "Tie" ? "tie" : pick}`;

/** The command line a click stands for, so every click teaches its typed form. */
export const injectLine = (duel: string, side: Target, text: string, kind: Direction | null = null) =>
  `inject ${duel} ${side}${kind ? ` ${kind.toLowerCase()}` : ""} "${text.replace(/"/g, "'")}"`;
