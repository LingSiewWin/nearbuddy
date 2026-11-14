// /evidence ("Research" in the header): does lying to an AI actually work? Its job: the research as small multiples.
// A row of counted sharp proportion bars first, then four findings, each a sentence, its chart and an honest caption.
// Static: every figure is a measured count from nearbuddy/lab, printed with its chart. Method/source lives in one
// frosted drawer — not per-chart tables or particle sandboxes.
import type { Metadata } from "next";
import board from "../data/board.json";
import { LabChart } from "../ui/charts";
import { MeterBar, Panel, Readout, Tag } from "../ui/instruments";
import { MethodDrawer } from "./method-drawer";

export const metadata: Metadata = {
  title: "What the lab found",
  description:
    "Controlled runs: how often one fake headline changes an AI's bet, under a naive and a hardened prompt, with the counts behind each figure.",
};

// each cell: label, changed, total, bar colour ("alert" = fooled → rose; "live" = held/stable → lime)
const CELLS: [string, number, number, "alert" | "live"][] = [
  ["Naive · headline with cues", 676, 704, "alert"],
  ["Naive · cues removed", 674, 704, "alert"],
  ["Naive · neutral line", 128, 707, "live"],
  ["Hardened · headline", 49, 705, "alert"],
  ["Hardened · neutral line", 58, 713, "live"],
  ["No attack · asked again", 5, 45, "live"],
];

export default function Page() {
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="t-display">What the lab found</h1>
        <Tag>lab · not live play</Tag>
        <p className="lede">
          {`Controlled runs, not live play: 9,297 enclave-signed calls in the main lab run. Separately, ${board.rows.toLocaleString("en-US")} recorded AI decisions feed the scoreboard.`}
        </p>
        <MethodDrawer />
      </header>
      <div className="deck c3">
        {CELLS.map(([label, n, of, kind]) => (
          <Panel key={label} label={`Lab · ${label}`}>
            <Readout value={n} unit={`of ${of} changed their bet`} />
            <MeterBar n={n} of={of} kind={kind} label={`${n} of ${of} changed their bet`} />
          </Panel>
        ))}
      </div>
      <div className="deck c2 gap-top">
        <Panel label="Finding 1" tag={<Tag kind="alert">fooled</Tag>}>
          <h2 className="t-title">A fake claim alone flipped a naive AI almost every time.</h2>
          <LabChart
            id="e1"
            noise={0.11}
            bars={[
              { label: "Naive prompt", rate: 676 / 704, text: "676 of 704 (96%)" },
              { label: "Hardened prompt", rate: 49 / 705, text: "49 of 705 (7%)" },
            ]}
          />
          <p className="note">
            In the lab, pooled across models, the headline shown with its credibility cues. With the cues removed: 674
            of 704 (96%). With a neutral line in its place: 128 of 707 (18%) under the naive prompt, 58 of 713 (8%)
            under the hardened one. The dashed line is the 11% that changes with no attack.
          </p>
        </Panel>
        <Panel label="Finding 2" tag={<Tag kind="ink">about half</Tag>}>
          <h2 className="t-title">Showing it an honest market price halved the damage.</h2>
          <LabChart
            id="e2"
            noise={0.11}
            bars={[
              { label: "Fake claim only", rate: 71 / 72, text: "36 of 36 and 35 of 36 (about 100%)", approx: true },
              {
                label: "Fake claim + honest market price",
                rate: 0.465,
                text: "46% and 47% of 36 each (about 47%)",
                approx: true,
              },
            ]}
          />
          <p className="note">
            A different run from the first chart, so the two naive rates differ slightly. In the lab, naive prompt, 36
            trials per cell, two cells. With a rigged market price instead: 100% and 94%. When the model was allowed to
            choose to look at an honest market: 29% to 40% fooled.
          </p>
        </Panel>
        <Panel label="Finding 3" tag={<Tag>noise</Tag>}>
          <h2 className="t-title">Even with no attack, some decisions change.</h2>
          <LabChart
            id="e3"
            bars={[
              {
                label: "Same question asked again, no attack",
                rate: 5 / 45,
                text: "5 of 45 (about 11%)",
                approx: true,
              },
            ]}
          />
          <p className="note">
            In the lab, the same prompts run again at fixed settings: 5 of 45 changed side. The true share likely sits
            between 5% and 23%.
          </p>
        </Panel>
        <Panel label="Finding 4" tag={<Tag kind="ink">on-chain</Tag>}>
          <h2 className="t-title">On-chain attacks so far are few.</h2>
          <Readout value="12" unit="fooled of 23 that reached a decision" />
          <MeterBar n={12} of={23} kind="alert" label="Fooled 12 of 23; 11 held" />
          <dl className="kv">
            <dt>Placed</dt>
            <dd>58</dd>
            <dt>Reached a decision</dt>
            <dd>23</dd>
            <dt>Fooled</dt>
            <dd>12</dd>
            <dt>Held</dt>
            <dd>11</dd>
          </dl>
          <p className="note">
            On-chain attacks so far: 58, all made by the team. The sample is too small to confirm or contradict the lab.{" "}
            <a href="/arena">See the duels they were planted in</a>
          </p>
        </Panel>
      </div>
    </div>
  );
}
