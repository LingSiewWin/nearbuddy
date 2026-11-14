// /board: which AI is hardest to fool? A fixed snapshot of the decisions dataset (/api/board), ranked on the page.
import type { Metadata } from "next";
import BoardView from "./board";

export const metadata: Metadata = {
  title: "Hardest to fool",
  description:
    "AI models ranked by how often one planted headline changed their bet, each with its count and its 95% interval.",
};

export default function Page() {
  return <BoardView />;
}
