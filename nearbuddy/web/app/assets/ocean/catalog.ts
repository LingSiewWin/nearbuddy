// Model catalog for the duel dock — seeded only from board.json rows.
import type { ModelSpec } from "./arena-types";
import { heldOf, rateOf } from "./tiers";
import { shortModelLabel, type BoardModelRow } from "./simulation";

/** Build the selectable catalog from real board models. No fictional NEAR AI ids. */
export function catalogFromBoard(models: BoardModelRow[]): ModelSpec[] {
  return models.map((m, i) => {
    const r = { tested: m.tested, fooled: m.fooled };
    const held = heldOf(r);
    return {
      modelId: m.model,
      name: shortModelLabel(m.model),
      tested: m.tested,
      fooled: m.fooled,
      held,
      baseResilience: rateOf(r),
      accentPalette: (i % 3) as 0 | 1 | 2,
    };
  });
}
