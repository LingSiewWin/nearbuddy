// /evidence ("Research" in the header): does lying to an AI actually work? Four findings from the lab, the sentence
// first and the chart second. Static: every figure is a measured count from nearbuddy/lab, printed with its chart.
import type { Metadata } from "next";
import board from "../data/board.json";
import { REPO } from "../tui";
import { LabChart } from "../ui/charts";

export const metadata: Metadata = {
  title: "What the lab found",
  description:
    "Controlled runs: how often one fake headline changes an AI's bet, under a naive and a hardened prompt, with the counts behind each figure.",
};

const DATA = `${REPO}/tree/HEAD/nearbuddy/lab`;
const data = (
  <a href={DATA} target="_blank" rel="noreferrer">
    The data
  </a>
);

export default function Page() {
  return (
    <div className="page stack-5">
      <div className="stack-2">
        <h1 className="t-display">What the lab found</h1>
        <p>
          {`Controlled runs, not live play: 9,297 enclave-signed calls in the lab. Separately, ${board.rows.toLocaleString("en-US")} recorded AI decisions feed the scoreboard.`}
        </p>
      </div>
      <div className="panels">
        <section className="sect stack">
          <h2 className="t-title">A fake claim alone flipped a naive AI almost every time.</h2>
          <LabChart
            id="e1"
            noise={0.11}
            bars={[
              { label: "Naive prompt", rate: 676 / 704, text: "676 of 704 (96%)" },
              { label: "Hardened prompt", rate: 49 / 705, text: "49 of 705 (7%)" },
            ]}
          />
          <p className="t-small dim">
            In the lab, pooled across models, the headline shown with its credibility cues. With the cues removed: 674
            of 704 (96%). With a neutral line in its place: 128 of 707 (18%) under the naive prompt, 58 of 713 (8%)
            under the hardened one. The dashed line is the 11% that changes with no attack. {data}
          </p>
        </section>
        <section className="sect stack">
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
          <p className="t-small dim">
            A different run from the first chart, so the two naive rates differ slightly. In the lab, naive prompt, 36
            trials per cell, two cells. With a rigged market price instead: 100% and 94%. {data}
          </p>
        </section>
        <section className="sect stack">
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
          <p className="t-small dim">
            In the lab, the same prompts run again at fixed settings: 5 of 45 changed side. The true share likely sits
            between 5% and 23%. {data}
          </p>
        </section>
        <section className="sect stack">
          <h2 className="t-title">Live attacks are few so far.</h2>
          <p>
            Live attacks so far: 58, all made by the team. The live record is too small to confirm or contradict the
            lab.
          </p>
          <p className="mono">58 placed · 23 reached a decision (12 fooled, 11 held)</p>
        </section>
      </div>
    </div>
  );
}
