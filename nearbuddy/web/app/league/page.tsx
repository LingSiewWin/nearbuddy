// /league: the league home that was the front page before the Trace design, kept reachable by URL in its old look.
import type { Metadata } from "next";
import "../term/term.css";
import League from "./league";

export const metadata: Metadata = { title: "League" };

export default function Page() {
  return (
    <div className="term-tokens">
      <League />
    </div>
  );
}
