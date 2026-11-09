// POST {payload}: relay a headline to the solver (see ../chaos.ts).
import { relayChaos } from "../chaos";
import { SOLVER_URL } from "../near";

export const POST = (req: Request) => relayChaos(req, SOLVER_URL);
