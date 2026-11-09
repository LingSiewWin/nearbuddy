// The "hardest to fool" board: per-model flips under attack from the published dataset (app/data/board.json,
// rebuilt by scripts/board.ts). The page computes each Wilson interval from these counts.
import board from "../../data/board.json";
import { json } from "../near";

export const GET = () => json(JSON.stringify(board));
