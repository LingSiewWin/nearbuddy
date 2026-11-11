// No-stake predictions as lines inside the terminal's panes (term.tsx): one market's picks as buttons with the crowd's
// split, who can steer it and the viewer's own call; and the predictions the viewer holds, with the settle and claim
// that pay their deposits back. The page reads GET /api/predict and owns the wallet: a button hands its pick to the
// page, which types the `predict` command it stands for and signs that.
import type { Market } from "../api/predict";
import type { Pick, PredictionView } from "../lib/abi/predict";
import { crowdLine, resultLine, SAYS, split, steerLine } from "../lib/predict";
import { type Cell, Line, Note } from "./box";

/** A pick as its button says it. */
const WORD: Record<Pick, string> = { A: "A", B: "B", Tie: "tie", Flipped: "fooled", Held: "holds" };
const VERDICT_C = { Right: "win", Wrong: "loss", Void: "dim" } as const;

/** One market: `head`, then a button per pick with its share of the crowd; with `crowd` the crowd's leading pick in
 *  words; who can steer it; the viewer's call and its verdict. Closed, or already called, the picks show as text. */
export function Calls({
  w,
  head,
  picks,
  m,
  me,
  crowd = false,
  connected,
  onPick,
}: {
  w: number;
  head: string;
  picks: Pick[];
  /** Undefined until the page has read it. */
  m: Market | undefined;
  me: PredictionView | null;
  crowd?: boolean;
  /** False: no wallet yet, and each button's label says the click connects one first. */
  connected: boolean;
  onPick: (p: Pick) => void;
}) {
  if (!m)
    return (
      <Line
        w={w}
        cells={[
          { t: `${head} `, c: "dim" },
          { t: "reading the crowd", c: "dim" },
        ]}
      />
    );
  const pct = new Map(split(m).map((s) => [s.pick, s.pct]));
  const live = m.open && !me;
  const cells: Cell[] = [{ t: `${head} `, c: "dim" }];
  for (const p of picks) {
    const t = `${WORD[p]}${m.total ? ` ${pct.get(p)}%` : ""}`;
    cells.push(
      live
        ? {
            t: `[${t}]`,
            c: "hi",
            onClick: () => onPick(p),
            label: `predict ${SAYS[p]}, no stake${m.total ? `, ${pct.get(p)}% say so` : ""}${connected ? "" : "; connects a NEAR wallet first"}`,
          }
        : { t: me?.pick === p ? `▸${t}` : ` ${t}`, c: me?.pick === p || m.outcome === p ? "hi" : "dim" },
      " ",
    );
  }
  if (!live && !me) cells.push({ t: m.settled ? "· settled" : "· closed", c: "dim" });
  const say = crowd && (m.total || live) ? (crowdLine(m) ?? "no predictions yet: be the first") : null;
  const steer = m.open || me ? steerLine(m) : null;
  return (
    <>
      <Line w={w} cells={cells} />
      {say ? <Note w={w} text={say} /> : null}
      {steer ? <Note w={w} text={steer} /> : null}
      {me ? <Note w={w} c={me.verdict ? VERDICT_C[me.verdict] : "dim"} text={resultLine(me) ?? ""} /> : null}
    </>
  );
}

/** The predictions the viewer holds, newest first: each one's result, a settle per duel holding an unscored one whose
 *  answer is in, and one claim for every scored deposit. */
export function Held({
  w,
  held,
  decided,
  onSettle,
  onClaim,
}: {
  w: number;
  held: PredictionView[];
  /** Whether its answer is in (the duel resolved, or the attack decided), so `settle` would score it. */
  decided: (p: PredictionView) => boolean;
  onSettle: (duel: string) => void;
  onClaim: () => void;
}) {
  const shown = [...held].reverse().slice(0, 4);
  const settle = [...new Set(held.filter((p) => !p.verdict && decided(p)).map((p) => p.duel_id))].slice(0, 3);
  const scored = held.filter((p) => p.verdict).length;
  return (
    <>
      <Line w={w} cells={[{ t: "your predictions", c: "dim" }]} />
      {shown.map((p) => (
        <Note
          key={`${p.duel_id}:${p.index}`}
          w={w}
          c={p.verdict ? VERDICT_C[p.verdict] : "dim"}
          text={`#${p.duel_id} ${p.index === null ? "who wins" : `attack ${p.index}`}: ${resultLine(p) ?? ""}`}
        />
      ))}
      {held.length > shown.length ? (
        <Line w={w} cells={[{ t: `+${held.length - shown.length} more`, c: "dim" }]} />
      ) : null}
      {settle.length || scored ? (
        <Line
          w={w}
          cells={[
            ...settle.flatMap((d): Cell[] => [
              { t: `[settle #${d}]`, onClick: () => onSettle(d), label: `score the predictions on duel ${d}` },
              " ",
            ]),
            scored
              ? {
                  t: `[claim ${scored} deposit${scored > 1 ? "s" : ""} back]`,
                  c: "ok",
                  onClick: onClaim,
                  label: `claim the deposits of your ${scored} scored prediction${scored > 1 ? "s" : ""}`,
                }
              : "",
          ]}
        />
      ) : null}
    </>
  );
}
