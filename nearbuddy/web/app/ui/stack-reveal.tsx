"use client";
// Kinetic stack list for the home page: numbered rows that expand on hover/focus/click to show what NearBuddy
// wired to NEAR. Pattern adapted from 21st.dev KineticTeamHybrid (numbered rows + expand reveal), without the
// stock portraits, Tailwind, shadcn, or framer-motion. Lives in app/ui/ with the rest of the Trace design —
// NearBuddy has no shadcn components folder; adding one would fork the design system for a single section.
import { useId, useState } from "react";
import board from "../data/board.json";
import { NET } from "../network";

type StackItem = {
  id: string;
  label: string;
  proof: string;
  detail: string;
  href: string;
  hrefLabel: string;
  mono?: string;
};

const STACK: StackItem[] = [
  {
    id: "enclave",
    label: "NEAR AI Cloud enclave",
    proof: "Every decision signed in sealed hardware",
    detail:
      "The agent runs inside a NEAR AI Cloud enclave. The hardware signs each completion; the arena accepts a decision only when that signature checks.",
    href: "/evidence",
    hrefLabel: "Lab and live numbers →",
  },
  {
    id: "arena",
    label: "Arena contract on NEAR",
    proof: "Checks signatures, settles, pays out",
    detail:
      "The contract records whether a planted headline flipped the bet, and pays from the loser's bond when the rules say so. Verdicts come from public chain data.",
    href: `${NET.explorer}/address/${NET.arena}`,
    hrefLabel: "Contract on NearBlocks ↗",
    mono: NET.arena,
  },
  {
    id: "paygate",
    label: "Chain Signatures · payment gate",
    proof: "USDC on Base, only inside an owner policy",
    detail:
      "A second contract lets an agent pay USDC on Base through NEAR Chain Signatures, only when a listed enclave signed the completion and the spend stays inside the owner's cap, payees and expiry.",
    href: "https://github.com/LingSiewWin/nearbuddy/tree/HEAD/nearbuddy/paygate#readme",
    hrefLabel: "Payment gate README ↗",
    mono: "nearbuddy-paygate-v2.testnet",
  },
  {
    id: "dataset",
    label: "Dataset · verify path",
    proof: `${board.rows.toLocaleString("en-US")} decisions · re-check any duel`,
    detail:
      "Each row keeps the request and response bytes and the enclave signature. Open a duel on /board, or run the same checks the site runs from public RPC.",
    href: "/board",
    hrefLabel: "See every decision →",
  },
  {
    id: "mcp",
    label: "MCP · agent API",
    proof: "Seven tools · no login · no keys",
    detail:
      "Agents play over Streamable HTTP: list the arena, read a duel, plant a headline, claim, enter, verify. The manual is /llms.txt.",
    href: "/llms.txt",
    hrefLabel: "Agent manual →",
    mono: "/api/mcp",
  },
];

/** Numbered kinetic rows: hover or tap expands one row and shows the proof line for that NEAR integration. */
export function StackReveal() {
  const [open, setOpen] = useState<string | null>(STACK[0]?.id ?? null);
  const labelId = useId();

  return (
    <section className="stack-reveal" aria-labelledby={labelId}>
      <header className="stack-reveal-head">
        <p className="t-label">On NEAR</p>
        <h2 id={labelId} className="stack-reveal-title">
          What this product wired
        </h2>
        <p className="stack-reveal-lede">
          Hover or tap a row. Each line is a real integration judges can open from this page.
        </p>
      </header>
      <ul className="stack-reveal-list" onMouseLeave={() => setOpen(STACK[0]?.id ?? null)}>
        {STACK.map((item, i) => {
          const active = open === item.id;
          const n = String(i + 1).padStart(2, "0");
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`stack-reveal-row${active ? " is-open" : ""}`}
                aria-expanded={active}
                onMouseEnter={() => setOpen(item.id)}
                onFocus={() => setOpen(item.id)}
                onClick={() => setOpen(item.id)}
              >
                <span className="stack-reveal-no" aria-hidden="true">
                  {n}
                </span>
                <span className="stack-reveal-main">
                  <span className="stack-reveal-label">{item.label}</span>
                  <span className="stack-reveal-proof mono">{item.proof}</span>
                </span>
                <span className="stack-reveal-mark" aria-hidden="true">
                  {active ? "−" : "+"}
                </span>
              </button>
              <div
                className={`stack-reveal-panel${active ? " is-open" : ""}`}
                aria-hidden={!active}
                inert={!active ? true : undefined}
              >
                <p>{item.detail}</p>
                {item.mono ? <p className="mono dim stack-reveal-mono">{item.mono}</p> : null}
                <a
                  className="btn-link"
                  href={item.href}
                  tabIndex={active ? 0 : -1}
                  {...(item.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {item.hrefLabel}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="stack-reveal-foot mono dim">
        arena{" "}
        <a href={`${NET.explorer}/address/${NET.arena}`} target="_blank" rel="noreferrer">
          {NET.arena} ↗
        </a>
      </p>
    </section>
  );
}
