// The scoreboard's ranking rule and the Verify drawer's grouping, both pure. A model is ranked only with 10 or more
// counted attacks, by the worst case its record still allows (the upper end of the 95% Wilson interval, lowest
// first); below that it is listed as counts and never ranked. Lab runs are never part of this.
import { rank, wilson } from "../lib/fool";

export const MIN_RANKED = 10;
export type BoardModel = {
  model: string;
  attacks: number;
  tested: number;
  fooled: number;
  against_tested: number;
  against_fooled: number;
};
/** One row as the board prints it: "fooled {fooled} of {tested}". */
export type BoardRow = { model: string; tested: number; fooled: number };
export type BoardMode = "all" | "against";

/** `all`: every counted attack. `against`: only attacks that pushed against where the price was already going. */
export function splitBoard(models: BoardModel[], mode: BoardMode): { ranked: BoardRow[]; few: BoardRow[] } {
  const rows = models.map((m) =>
    mode === "all"
      ? { model: m.model, tested: m.tested, fooled: m.fooled }
      : { model: m.model, tested: m.against_tested, fooled: m.against_fooled },
  );
  return {
    ranked: rank(rows.filter((r) => r.tested >= MIN_RANKED)),
    few: rows
      .filter((r) => r.tested < MIN_RANKED)
      .sort((a, b) => b.tested - a.tested || a.model.localeCompare(b.model)),
  };
}

/** "Likely between 8% and 48%.": the 95% interval for fooled ÷ counted, in whole percent. */
export function likely(fooled: number, n: number): string {
  const [lo, hi] = wilson(fooled, n);
  return `Likely between ${Math.round(lo * 100)}% and ${Math.round(hi * 100)}%.`;
}

// ---------------------------------------------------------------- verify lines

export type CheckLine = { result: "PASS" | "FAIL" | "SKIP" | "INFO"; check: string; detail: string };
export const CHECK_GROUPS: [string, string[]][] = [
  ["The duel was opened properly", ["duel", "opened", "opener refund", "agent ", "oracle open"]],
  ["Every decision was signed in the enclave", ["intent ", "keyless "]],
  ["Headlines and money locked", ["injection", "chaos records"]],
  [
    "Result and payouts follow the rules",
    ["oracle ", "pnl ", "winner and slash", "payout", "owner fees", "no-reveal", "shield", "chaos settlement", "void"],
  ],
];
export const OTHER_CHECKS = "Other checks";
export type CheckGroup = {
  name: string;
  lines: CheckLine[];
  /** ✓ only if every line passed; ✕ if any failed; "skip" if none failed and any was not checked. */
  mark: "pass" | "fail" | "skip";
};

const ORDER = { FAIL: 0, PASS: 1, SKIP: 1, INFO: 2 } as const;

/** The lines in their groups, by the start of the check's name, the first match winning; anything unmatched goes
 *  to "Other checks", so a new check is never hidden. Failing rows come first, INFO rows last. Empty groups are
 *  left out. INFO lines do not count toward a group's mark. */
export function groupChecks(lines: CheckLine[]): CheckGroup[] {
  const names = [...CHECK_GROUPS.map(([n]) => n), OTHER_CHECKS];
  const by = new Map<string, CheckLine[]>(names.map((n) => [n, []]));
  for (const l of lines) {
    const hit = CHECK_GROUPS.find(([, starts]) => starts.some((s) => l.check.startsWith(s)));
    by.get(hit?.[0] ?? OTHER_CHECKS)?.push(l);
  }
  return names.flatMap((name) => {
    const ls = [...(by.get(name) ?? [])].sort((a, b) => ORDER[a.result] - ORDER[b.result]);
    if (!ls.length) return [];
    const mark = ls.some((l) => l.result === "FAIL") ? "fail" : ls.some((l) => l.result === "SKIP") ? "skip" : "pass";
    return [{ name, lines: ls, mark }];
  });
}
