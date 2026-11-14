// The decision field: every recorded decision of the dataset as one mark, grouped by model and by duel. This file is
// the pure part: the compact data (app/data/field.json, written by scripts/field.ts) in, and the position of every
// mark out, for the canvas (ui/field-view.tsx) and for its counts.

export type FieldData = {
  source: string;
  rows: number;
  models: string[];
  /** Oldest duel first. `d` holds one character per decision of that agent in that duel, oldest first:
   *  `.` no headline in view, `:` a headline in view, `f` fooled, `h` held, `n` a new headline that did not count,
   *  `-` no decision posted. */
  duels: { id: string; agents: { m: number; d: string }[] }[];
};
export type MarkKind = "." | ":" | "f" | "h" | "n" | "-";
export type FieldMark = { x: number; y: number; kind: MarkKind; duel: string; model: number };
export type FieldBand = { model: number; y: number; h: number; counts: Record<MarkKind, number>; total: number };
export type FieldLayout = {
  width: number;
  height: number;
  step: number;
  cols: number;
  bands: FieldBand[];
  marks: FieldMark[];
};

const KINDS: MarkKind[] = [".", ":", "f", "h", "n", "-"];
const zero = (): Record<MarkKind, number> => ({ ".": 0, ":": 0, f: 0, h: 0, n: 0, "-": 0 });

/** Per-model counts of each kind of mark: the models that faced the most headlines first, then the most decisions. */
export function fieldCounts(data: FieldData): { model: number; counts: Record<MarkKind, number>; total: number }[] {
  const by = data.models.map((_, model) => ({ model, counts: zero(), total: 0 }));
  for (const d of data.duels)
    for (const a of d.agents) {
      const b = by[a.m];
      if (!b) continue;
      for (const ch of a.d) {
        if (!KINDS.includes(ch as MarkKind)) continue;
        b.counts[ch as MarkKind]++;
        b.total++;
      }
    }
  const faced = (c: Record<MarkKind, number>) => c.f + c.h + c.n;
  return by.sort((x, y) => faced(y.counts) - faced(x.counts) || y.total - x.total || x.model - y.model);
}

/** Lays the field out for a canvas `width` px wide: one band per model (in fieldCounts order), each band a grid of
 *  `step`-px cells filled left to right and top to bottom, one run of cells per agent per duel with one empty cell
 *  between runs. `head` px are left above each band for its label. Every decision gets exactly one mark, inside the
 *  width; a width too narrow for one cell gives an empty layout. */
export function fieldLayout(data: FieldData, width: number, step = 6, head = 22, gap = 10): FieldLayout {
  const cols = Math.floor(width / step);
  const out: FieldLayout = { width, height: 0, step, cols, bands: [], marks: [] };
  if (cols < 2) return out;
  let y = 0;
  for (const { model, counts, total } of fieldCounts(data)) {
    if (!total) continue;
    const top = y + head;
    let [col, row] = [0, 0];
    for (const d of data.duels)
      for (const a of d.agents) {
        if (a.m !== model || !a.d.length) continue;
        // keep a short run on one line when it fits; a run longer than a line simply wraps
        if (col > 0 && col + a.d.length > cols && a.d.length <= cols) [col, row] = [0, row + 1];
        for (const ch of a.d) {
          if (col >= cols) [col, row] = [0, row + 1];
          out.marks.push({ x: col * step, y: top + row * step, kind: ch as MarkKind, duel: d.id, model });
          col++;
        }
        col++; // one empty cell between runs
      }
    const h = (row + 1) * step;
    out.bands.push({ model, y, h: head + h, counts, total });
    y = top + h + gap;
  }
  out.height = Math.max(0, y - gap);
  return out;
}

/** The mark under a point, or null: the canvas's hit test. */
export function markAt(layout: FieldLayout, x: number, y: number): FieldMark | null {
  const s = layout.step;
  return layout.marks.find((m) => x >= m.x && x < m.x + s && y >= m.y && y < m.y + s) ?? null;
}
