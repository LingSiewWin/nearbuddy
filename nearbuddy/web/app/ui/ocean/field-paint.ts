// Architectural ASCII mosaic: light grid + density tiles; sharks/prey carved from the field.
import {
  accentRgb,
  cellFill,
  cellHash,
  cellInk,
  mosaicGlyph,
  MOSAIC,
} from "../../assets/ocean/ramp";
import { ribbonDensity } from "../../assets/ocean/noise";
import { samplePrey, sampleShark, toLocal, type Part } from "../../assets/ocean/shapes";

export type FieldActor =
  | { kind: "shark"; x: number; y: number; length: number; heading: number; phase: number; depth: number }
  | { kind: "prey"; x: number; y: number; length: number; heading: number; alive: boolean };

export type Pointer = { x: number; y: number; active: boolean };

const PITCH = MOSAIC.pitch;

function partBoost(part: Part): number {
  if (part === "empty") return 0;
  if (part === "eye") return 1;
  if (part === "edge") return 0.82;
  if (part === "fin") return 0.7;
  return 0.92;
}

function silhouetteAt(px: number, py: number, actors: FieldActor[]): { boost: number; prey: boolean; edge: boolean } {
  let best = 0;
  let prey = false;
  let edge = false;
  for (const a of actors) {
    if (a.kind === "prey" && !a.alive) continue;
    const { s, n } = toLocal(px, py, a.x, a.y, a.length, a.heading);
    const wave = a.kind === "shark" ? Math.sin(a.phase) * 0.45 : 0;
    const part = a.kind === "shark" ? sampleShark(s, n, wave) : samplePrey(s, n);
    const b = partBoost(part) * (a.kind === "shark" ? a.depth : 1);
    if (b > best) {
      best = b;
      prey = a.kind === "prey";
      edge = part === "edge" || part === "fin";
    }
  }
  return { boost: best, prey, edge };
}

/** Paint one mosaic frame into CSS-pixel space (ctx already scaled by dpr). */
export function paintField(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  actors: FieldActor[],
  tSec: number,
  pointer: Pointer,
  flash = 0,
) {
  const cols = Math.ceil(w / PITCH);
  const rows = Math.ceil(h / PITCH);

  ctx.fillStyle = MOSAIC.bg;
  ctx.fillRect(0, 0, w, h);

  // fine square grid
  ctx.strokeStyle = MOSAIC.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = c * PITCH + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * PITCH + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.font = `600 ${Math.floor(PITCH * 0.72)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = gx * PITCH + PITCH * 0.5;
      const cy = gy * PITCH + PITCH * 0.5;

      let dens = ribbonDensity(cx, cy, tSec);

      // mouse ripple / repulsion: push density away from pointer
      if (pointer.active) {
        const dx = cx - pointer.x;
        const dy = cy - pointer.y;
        const d2 = dx * dx + dy * dy;
        const r = 110;
        if (d2 < r * r) {
          const fall = 1 - Math.sqrt(d2) / r;
          dens = dens * (1 - fall * 0.85) + fall * 0.08;
        }
      }

      const sil = silhouetteAt(cx, cy, actors);
      if (sil.boost > 0) {
        // carve creature: raise density inside silhouette so glyphs form the animal
        dens = Math.min(1, dens * 0.35 + sil.boost * (0.55 + dens * 0.45));
      } else {
        dens *= 0.72; // quieter ambient ribbons so animals read
      }

      if (flash > 0 && sil.boost > 0.4) dens = Math.min(1, dens + flash * 0.35);

      if (dens < 0.08) continue;

      const salt = Math.floor(cellHash(gx, gy, Math.floor(tSec * 2)) * 1000);
      let fill = cellFill(dens);

      // iridescent glints on high-density creature edges
      if (sil.boost > 0.5 && (sil.edge || dens > 0.78) && salt % 7 === 0) {
        const [ar, ag, ab] = accentRgb(salt);
        const k = sil.prey ? 0.55 : 0.35;
        const mix = (ch: number, base: number) => Math.round(base * (1 - k) + ch * k);
        const lo = dens > 0.5 ? [0x22, 0x22, 0x26] : [0xec, 0xec, 0xef];
        fill = `rgb(${mix(ar, lo[0])},${mix(ag, lo[1])},${mix(ab, lo[2])})`;
      } else if (sil.prey && dens > 0.3) {
        // prey reads slightly coral
        const k = 0.22;
        const base = dens > 0.45 ? [0x22, 0x22, 0x26] : [0xec, 0xec, 0xef];
        fill = `rgb(${Math.round(base[0] * (1 - k) + 170 * k)},${Math.round(base[1] * (1 - k) + 110 * k)},${Math.round(base[2] * (1 - k) + 110 * k)})`;
      }

      const pad = 1;
      ctx.fillStyle = fill;
      ctx.fillRect(gx * PITCH + pad, gy * PITCH + pad, PITCH - pad * 2, PITCH - pad * 2);

      const ch = mosaicGlyph(dens, salt);
      if (ch !== " ") {
        ctx.fillStyle = cellInk(dens);
        ctx.globalAlpha = 0.85 + dens * 0.15;
        ctx.fillText(ch, cx, cy + 0.5);
        ctx.globalAlpha = 1;
      }
    }
  }
}

/** Choreography t ∈ [0,1]: shark hunts prey across the mosaic. */
export function actorsAt(t: number, w: number, h: number): { actors: FieldActor[]; flash: number } {
  const preyAlive = t < 0.52;
  const eat = t >= 0.48 && t < 0.58;
  const flash = eat ? Math.sin(((t - 0.48) / 0.1) * Math.PI) : 0;

  const preyX = w * (0.32 + 0.06 * Math.sin(t * Math.PI * 2));
  const preyY = h * 0.58;
  const sharkX = t < 0.5 ? w * (0.95 - 0.55 * (t / 0.5)) : w * (0.4 + 0.18 * ((t - 0.5) / 0.5));
  const sharkY = h * (0.55 + 0.05 * Math.sin(t * Math.PI * 4));
  const heading = t < 0.5 ? Math.PI : 0.12;
  const span = Math.min(w, h);

  const actors: FieldActor[] = [
    {
      kind: "shark",
      x: w * 0.78,
      y: h * 0.28,
      length: span * 0.62,
      heading: -0.55,
      phase: t * Math.PI * 4,
      depth: 0.55,
    },
    {
      kind: "shark",
      x: sharkX,
      y: sharkY,
      length: span * 0.85,
      heading,
      phase: t * Math.PI * 6,
      depth: 1,
    },
    {
      kind: "prey",
      x: preyX,
      y: preyY,
      length: span * 0.16,
      heading: 0.25,
      alive: preyAlive,
    },
    {
      kind: "prey",
      x: preyX - PITCH * 2.2,
      y: preyY - PITCH * 1.4,
      length: span * 0.12,
      heading: -0.15,
      alive: preyAlive && t < 0.5,
    },
    {
      kind: "prey",
      x: preyX - PITCH * 1.4,
      y: preyY + PITCH * 1.6,
      length: span * 0.13,
      heading: 0.45,
      alive: preyAlive && t < 0.51,
    },
  ];
  return { actors, flash };
}
