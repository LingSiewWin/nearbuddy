"use client";
// Kinetic stack list for the home page: numbered rows for what NearBuddy wired to NEAR. With a mouse, the row under
// the pointer slides right, the others dim, and a card with that row's detail follows the pointer on a spring; the
// row itself is the link. On a touch screen a tap opens the detail under the row. Pattern adapted from 21st.dev
// KineticTeamHybrid, without the stock portraits, Tailwind, shadcn, or framer-motion: the motion is CSS transitions
// and one requestAnimationFrame spring. Lives in app/ui/ with the rest of the Trace design.
import { useEffect, useId, useRef, useState } from "react";
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

const CARD = { w: 340, gap: 20, edge: 16 };
const ext = (href: string) => (href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {});

/** Numbered kinetic rows, the body of the home page's fourth chapter (its heading comes from ui/hero.tsx).
 *  Mouse: hover a row, a detail card follows the pointer. Touch: tap a row to open it. */
export function StackReveal() {
  const [active, setActive] = useState<string | null>(null);
  // the card keeps its last content while it fades out
  const [shown, setShown] = useState<StackItem | null>(null);
  const [touch, setTouch] = useState(false);
  const labelId = useId();
  const card = useRef<HTMLDivElement>(null);
  const to = useRef({ x: 0, y: 0 });
  const at = useRef({ x: 0, y: 0, set: false });

  useEffect(() => {
    const mq = window.matchMedia("(hover: none), (max-width: 767px)");
    const on = () => {
      setTouch(mq.matches);
      setActive(null);
    };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // the spring: each frame the card closes a fixed share of the distance to the pointer. It runs only while a row is
  // active, and snaps when the visitor asked for reduced motion.
  useEffect(() => {
    if (touch || !active) return;
    const pull = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0.16;
    let raf = 0;
    const tick = () => {
      const p = at.current;
      if (!p.set) {
        p.x = to.current.x;
        p.y = to.current.y;
        p.set = true;
      }
      p.x += (to.current.x - p.x) * pull;
      p.y += (to.current.y - p.y) * pull;
      if (card.current) card.current.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, touch]);

  /** Aim the card at a point, kept inside the window. */
  const aim = (x: number, y: number) => {
    const h = card.current?.offsetHeight ?? 220;
    to.current = {
      x: Math.max(CARD.edge, Math.min(x + CARD.gap, window.innerWidth - CARD.w - CARD.edge)),
      y: Math.max(CARD.edge, Math.min(y + CARD.gap, window.innerHeight - h - CARD.edge)),
    };
  };
  const show = (item: StackItem) => {
    setShown(item);
    setActive(item.id);
  };
  const hide = () => {
    setActive(null);
    at.current.set = false;
  };

  return (
    <div className="stack-reveal">
      <ul
        className={`stack-reveal-list${active ? " has-active" : ""}`}
        onPointerMove={(e) => {
          if (!touch && e.pointerType === "mouse") aim(e.clientX, e.clientY);
        }}
      >
        {STACK.map((item, i) => {
          const on = active === item.id;
          const inner = (
            <>
              <span className="stack-reveal-lead">
                <span className="stack-reveal-no" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="stack-reveal-label">{item.label}</span>
              </span>
              <span className="stack-reveal-tail">
                <span className="stack-reveal-proof">{item.proof}</span>
                <span className="stack-reveal-mark" aria-hidden="true">
                  {touch ? (on ? "−" : "+") : "↗"}
                </span>
              </span>
            </>
          );
          return (
            <li key={item.id} className={on ? "is-active" : undefined}>
              {touch ? (
                <>
                  <button
                    type="button"
                    className="stack-reveal-row"
                    aria-expanded={on}
                    onClick={() => (on ? hide() : show(item))}
                  >
                    {inner}
                  </button>
                  <div className="stack-reveal-panel" inert={!on}>
                    <div>
                      <p>{item.detail}</p>
                      {item.mono ? <p className="mono dim">{item.mono}</p> : null}
                      <a className="btn-link" href={item.href} {...ext(item.href)}>
                        {item.hrefLabel}
                      </a>
                    </div>
                  </div>
                </>
              ) : (
                <a
                  className="stack-reveal-row"
                  href={item.href}
                  {...ext(item.href)}
                  aria-describedby={on ? `${labelId}-card` : undefined}
                  onMouseEnter={() => show(item)}
                  onMouseLeave={hide}
                  onFocus={(e) => {
                    // no pointer to follow: park the card beside the focused row
                    const r = e.currentTarget.getBoundingClientRect();
                    aim(r.left + r.width * 0.5, r.top);
                    show(item);
                  }}
                  onBlur={hide}
                >
                  {inner}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {touch ? null : (
        <div ref={card} className="stack-reveal-float" aria-hidden={!active}>
          <div id={`${labelId}-card`} className={`stack-reveal-card${active ? " is-on" : ""}`} role="tooltip">
            {shown ? (
              <>
                <p className="stack-reveal-card-top">
                  <span className="stack-reveal-dot" aria-hidden="true" />
                  {shown.label}
                </p>
                <p>{shown.detail}</p>
                {shown.mono ? <p className="mono stack-reveal-card-mono">{shown.mono}</p> : null}
                <p className="stack-reveal-card-go">{shown.hrefLabel}</p>
              </>
            ) : null}
          </div>
        </div>
      )}
      <p className="stack-reveal-foot mono dim">
        arena{" "}
        <a href={`${NET.explorer}/address/${NET.arena}`} target="_blank" rel="noreferrer">
          {NET.arena} ↗
        </a>
      </p>
    </div>
  );
}
