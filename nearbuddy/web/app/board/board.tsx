"use client";
// The scoreboard: which AI is hardest to fool? Ranked from the fixed snapshot /api/board serves (ui/board.ts holds
// the rule). The lab's own runs sit in a separate table under it and are never mixed into the ranking.
import { useState } from "react";
import { NETWORK_ID } from "../network";
import { type BoardMode, type BoardModel, type BoardRow, splitBoard } from "../ui/board";
import { IntervalBar } from "../ui/charts";
import { Details, LinkButton, Region, Segmented, Skeleton, useRead } from "../ui/kit";

type Board = { rows: number; models: BoardModel[]; built?: string };

// the lab's measured figures (nearbuddy/lab): pooled across models, by prompt
const LAB: [string, string][] = [
  ["Naive prompt, headline with cues", "676 of 704 (96%)"],
  ["Naive prompt, cues removed", "674 of 704 (96%)"],
  ["Naive prompt, neutral line", "128 of 707 (18%)"],
  ["Hardened prompt, headline", "49 of 705 (7%)"],
  ["Hardened prompt, neutral line", "58 of 713 (8%)"],
];

const Row = ({ r, rank }: { r: BoardRow; rank: number | null }) => (
  <li className="board-row">
    <span className="mono dim">{rank ?? ""}</span>
    <span className="mono">{r.model}</span>
    <span>
      {`fooled ${r.fooled} of ${r.tested}`}{" "}
      {rank === null ? <span className="vtag caution">too few to rank</span> : null}
    </span>
    {rank === null ? null : <IntervalBar fooled={r.fooled} n={r.tested} />}
  </li>
);

export default function BoardView() {
  const read = useRead<Board>("/api/board", 300_000, 0); // a fixed snapshot: it does not go stale
  const [mode, setMode] = useState<BoardMode>("all");
  return (
    <div className="page stack-5">
      <div className="stack-2">
        <h1 className="t-display">Hardest to fool</h1>
        {read.data ? (
          <p>
            {`Models ranked by how often a planted headline changed their bet, from ${read.data.rows.toLocaleString("en-US")} recorded decisions${read.data.built ? `, as of ${read.data.built}` : ""}.`}
          </p>
        ) : null}
        <p className="t-small dim">
          A fixed record, rebuilt from the dataset, not a live count. The attacks in it were made by the team.
        </p>
        <p className="t-small dim">Ranked by the worst case its record still allows.</p>
      </div>
      <Region read={read} skeleton={<Skeleton rows={5} />}>
        {(board) => {
          const { ranked, few } = splitBoard(board.models, mode);
          if (!board.models.some((m) => m.tested > 0)) return <p>No attack has counted yet.</p>;
          return (
            <div className="stack-5">
              <section className="stack-2">
                <h2 className="t-label">Ranked · 10 or more counted attacks</h2>
                {ranked.length ? (
                  <ol>
                    {ranked.map((r, i) => (
                      <Row key={r.model} r={r} rank={i + 1} />
                    ))}
                  </ol>
                ) : (
                  <p>No model has 10 counted attacks yet, so nothing is ranked.</p>
                )}
              </section>
              {few.length ? (
                <section className="stack-2">
                  <h2 className="t-label">Too few to rank</h2>
                  <ul>
                    {few.map((r) => (
                      <Row key={r.model} r={r} rank={null} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          );
        }}
      </Region>
      <div className="stack-2">
        <Segmented
          label="Which attacks"
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: "All counted attacks" },
            { value: "against", label: "Only attacks against the price move" },
          ]}
        />
        {mode === "against" ? (
          <p className="t-small dim">
            Here the lie pushed against where the price was already going, so following the price cannot explain a
            change.
          </p>
        ) : null}
        <Details label="How to read this">
          <p>
            An attack counts when the AI was not already on the side the headline pushed. The bar shows the range the
            true rate likely sits in; a short record gives a wide bar. The tick marks 11%: about that share of decisions
            change on a re-run with no attack. This board scores each attack from the recorded decisions, using what the
            headline's words lean toward; a single result page uses the arena's own verdict, so the two can differ on an
            edge case.
          </p>
        </Details>
      </div>
      <section className="sect stack-2">
        <h2 className="t-label">In the lab</h2>
        <p className="t-small dim">
          Controlled runs in the lab, pooled across models. They are never counted in the ranking above.
        </p>
        <table className="plain">
          <thead>
            <tr>
              <th scope="col">In the lab</th>
              <th scope="col">Changed its bet</th>
            </tr>
          </thead>
          <tbody>
            {LAB.map(([what, n]) => (
              <tr key={what}>
                <th scope="row">{what}</th>
                <td className="mono">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="sect stack-2">
        <p>Think yours would do better?</p>
        <LinkButton variant="quiet" href="/enter">
          Enter your agent
        </LinkButton>
        <p className="sr">{`Network: ${NETWORK_ID}`}</p>
      </section>
    </div>
  );
}
