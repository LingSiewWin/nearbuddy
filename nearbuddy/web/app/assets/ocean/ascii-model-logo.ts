// Brand-silhouette model-family logos for the ocean duel dock.
// Pure helpers — no React. Density stamps → ocean ASCII_RAMP.
// PNG sources (reference only): assets/ocean/brand-logos/*.png
import { ASCII_RAMP } from "./gaussian3d";
import { cellHash } from "./ramp";

export const LOGO_SIZE = 14;

export type ModelFamily = "deepseek" | "qwen" | "glm" | "gemini" | "claude" | "generic";

/** Reactive states shared with ocean creature outcome timers. */
export type LogoState = "idle" | "thinking" | "held" | "fooled";

export type LogoSignal = {
  thinkTimer: number;
  heldTimer: number;
  fooledTimer: number;
};

/**
 * Digits 0–9 / A–F = density. Each family is a 14×14 stamp.
 * Brand silhouettes hand-tuned from founder PNGs (DeepSeek knot, Zhipu Z,
 * Gemini 4-star, Claude starburst). Qwen kept as a distinct Q — no fake logo.
 */
const TEMPLATES: Record<ModelFamily, readonly string[]> = {
  // DeepSeek — purple interlocking hex / impossible knot (central triangle void)
  deepseek: [
    "00004CC5000000",
    "000268FE433100",
    "000633FFFFFF60",
    "0366609CCCCCB0",
    "0BC22000000260",
    "0FF42BBBBB8360",
    "08FD06FFFF4020",
    "02CF81CFF90A30",
    "006FF23FF24FC8",
    "02CFFB0981DFF8",
    "02FE330406FE80",
    "006944631FE500",
    "0012335AFB0000",
    "0000004BB30000",
  ],
  // Qwen — Q ring with a short tail (no brand asset; keep distinct)
  qwen: [
    "00000111100000",
    "00013666310000",
    "00148999841000",
    "0149AAAAA94100",
    "038A90009A8300",
    "069A80008A9600",
    "069A80008A9600",
    "069A80008A9600",
    "038A90009A8300",
    "0149AA9AA94100",
    "001489A9841000",
    "0001366A310000",
    "00000118A00000",
    "00000001A80000",
  ],
  // Zhipu / GLM — geometric italic Z (three segments, diagonal gaps)
  glm: [
    "00000000000000",
    "00CCCCCCCCCC00",
    "00CCCCCCCCC000",
    "00CCCC0AA00000",
    "0000000CCC0000",
    "000000CCC00000",
    "00000CCC000000",
    "0000CCC0000000",
    "000CCC00000000",
    "00CC0000000000",
    "0CCCCCCCCCC000",
    "0CCCCCCCCCCC00",
    "00000000000000",
    "00000000000000",
  ],
  // Google Gemini — four-point spark / concave diamond star
  gemini: [
    "000000A7000000",
    "000001EC000000",
    "000008FF600000",
    "00005FFFE30000",
    "0005FFFFFE4000",
    "029FFFFFFFF710",
    "BFFFFFFFFFFFE8",
    "7BFFFFFFFFFFB5",
    "005DFFFFFFD400",
    "0002DFFFFB1000",
    "00002EFFD10000",
    "000006FF400000",
    "000000DB000000",
    "00000086000000",
  ],
  // Anthropic Claude — organic starburst / coral rays (silhouette only)
  claude: [
    "0000800400C000",
    "00401C03E00800",
    "0018FC1E434000",
    "00C6AE3B3FC000",
    "00FEFEFBEF8000",
    "0005FFFFF8AC00",
    "08CF8FFFFFFA00",
    "0244EFFFFDBD00",
    "0035DEFFFE5600",
    "006CDCEBFD8000",
    "0013E1E3BC3000",
    "00801C21E00800",
    "00040000004000",
    "00000000000000",
  ],
  // Abstract node / fallback
  generic: [
    "00000111100000",
    "00013666310000",
    "00148AA8410000",
    "0149A00A941000",
    "038A8008A83000",
    "169A8AA8A96100",
    "16AAAAAAAA9610",
    "16AAAAAAAA9610",
    "169A8AA8A96100",
    "038A8008A83000",
    "0149A00A941000",
    "00148AA8410000",
    "00013666310000",
    "00000111100000",
  ],
};

const HEX = "0123456789ABCDEF";

function parseDensity(ch: string): number {
  const i = HEX.indexOf(ch.toUpperCase());
  if (i < 0) return 0;
  return i / 15;
}

function densify(template: readonly string[]): number[][] {
  return template.map((row) => [...row.padEnd(LOGO_SIZE, "0").slice(0, LOGO_SIZE)].map(parseDensity));
}

const DENSITY: Record<ModelFamily, number[][]> = {
  deepseek: densify(TEMPLATES.deepseek),
  qwen: densify(TEMPLATES.qwen),
  glm: densify(TEMPLATES.glm),
  gemini: densify(TEMPLATES.gemini),
  claude: densify(TEMPLATES.claude),
  generic: densify(TEMPLATES.generic),
};

export function modelFamilyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("qwen")) return "qwen";
  if (id.includes("glm") || id.includes("z-ai") || id.includes("/zai") || id.includes("zhipu")) return "glm";
  if (id.includes("gemini") || id.includes("google")) return "gemini";
  if (id.includes("claude") || id.includes("anthropic")) return "claude";
  return "generic";
}

/**
 * Priority matches the product stress test: evaluating → outcome.
 * Same timers the ocean creature uses after a sim round.
 */
export function logoStateOf(signal: LogoSignal): LogoState {
  if (signal.thinkTimer > 0) return "thinking";
  if (signal.fooledTimer > 0) return "fooled";
  if (signal.heldTimer > 0) return "held";
  return "idle";
}

function rampGlyph(density: number, salt: number): string {
  const t = Math.min(0.999, Math.max(0, density));
  const max = ASCII_RAMP.length - 1;
  const i = Math.min(max, Math.max(0, Math.round(t * max)));
  const j = Math.min(max, Math.max(0, i + ((salt % 3) - 1)));
  return ASCII_RAMP[j] ?? " ";
}

export type LogoRenderOpts = {
  family: ModelFamily;
  state: LogoState;
  /** Seconds remaining on the active timer (think/held/fooled). */
  timer: number;
  /** Wall time for scan/pulse phase; ignored when calm. */
  timeSec?: number;
  /** Snap to final readable glyph — no scatter/scan spam. */
  calm?: boolean;
};

/**
 * Build a 14×14 glyph grid for the current reactive state.
 * thinking: horizontal density wave / scanline
 * held: denser lock + short pulse (caller tints lime)
 * fooled: scatter into sparse noise then reform
 * idle: base stamp
 */
export function renderLogoGrid(opts: LogoRenderOpts): string[] {
  const { family, state, timer, calm = false } = opts;
  const timeSec = opts.timeSec ?? 0;
  const base = DENSITY[family] ?? DENSITY.generic;
  const lines: string[] = [];

  for (let y = 0; y < LOGO_SIZE; y++) {
    let row = "";
    for (let x = 0; x < LOGO_SIZE; x++) {
      let d = base[y]![x]!;
      const salt = Math.floor(cellHash(x, y, Math.floor(timeSec * 8)) * 1000);

      if (state === "thinking" && !calm) {
        const wave = 0.55 + 0.45 * Math.sin(timeSec * 10 + y * 0.55 - x * 0.12);
        const scan = Math.abs((y / (LOGO_SIZE - 1)) * 1.2 - ((timeSec * 1.8) % 1.2)) < 0.08 ? 0.35 : 0;
        d = Math.min(1, d * (0.35 + 0.75 * wave) + scan);
      } else if (state === "held") {
        const pulse = calm ? 1 : 1 + 0.22 * Math.sin(timeSec * 14) * Math.min(1, timer);
        d = Math.min(1, d * 1.35 * pulse + (d > 0.15 ? 0.08 : 0));
      } else if (state === "fooled") {
        if (calm) {
          d = d * 0.85;
        } else {
          const scatter = Math.min(1, timer / 1.2);
          const n = cellHash(x + 3, y + 7, Math.floor(timeSec * 20));
          if (scatter > 0.15) {
            d = d * (1 - scatter) + n * scatter * 0.55;
            if (n > 0.72 && scatter > 0.35) d *= 0.15;
          }
        }
      }

      row += d < 0.04 ? " " : rampGlyph(d, salt);
    }
    lines.push(row);
  }
  return lines;
}

export function logoTimerOf(signal: LogoSignal, state: LogoState): number {
  if (state === "thinking") return signal.thinkTimer;
  if (state === "fooled") return signal.fooledTimer;
  if (state === "held") return signal.heldTimer;
  return 0;
}
