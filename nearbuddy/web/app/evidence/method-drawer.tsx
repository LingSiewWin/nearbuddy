"use client";
// One frosted drawer for Research: how the lab and on-chain counts were made. Replaces per-chart "Show as table"
// and the repeated "The data" links. Field names mirror the lab row shape (prompt_digest, model_type, …).
import { useState } from "react";
import { REPO } from "../tui";
import { Drawer } from "../ui/kit";

const LAB = `${REPO}/tree/HEAD/nearbuddy/lab`;

/** Method rows: key in mono, value in plain words. Lab and on-chain stay labeled apart. */
const ROWS: [string, string][] = [
  ["prompt_digest", "Naive vs hardened system prompts in the controlled lab run"],
  ["model_type", "Pooled across models in that lab run"],
  ["flipped", "Bet side changed after the headline was shown"],
  ["enclave_sig", "Enclave-signed model calls (9,297 in the main lab run)"],
  ["lab_counts", "676/704, 674/704, 128/707, 49/705, 58/713, 5/45"],
  ["on_chain", "Team-planted sample so far: 58 placed, 23 decided, 12 fooled, 11 held"],
];

/** Opens the shared Research method drawer. One control for the whole page. */
export function MethodDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-quiet fit" onClick={() => setOpen(true)}>
        How these counts were made
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="How these counts were made" className="frost">
        <p className="note">
          Lab figures are controlled runs. The on-chain sample is separate, small, and team-planted so far — not
          stranger live play.
        </p>
        <dl className="kv method-kv">
          {ROWS.map(([k, v]) => (
            <div key={k} className="method-row">
              <dt className="mono">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="note">
          <a href={LAB} target="_blank" rel="noreferrer">
            Lab source on GitHub
          </a>
        </p>
      </Drawer>
    </>
  );
}
