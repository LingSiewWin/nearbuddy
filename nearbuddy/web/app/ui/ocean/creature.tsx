import { glyphOf, type TierId } from "../../assets/ocean";

export type CreatureTone = "lime" | "blue" | "white" | "dim" | "alert";

const TONE: Record<CreatureTone, string> = {
  lime: "var(--lime, #c6f432)",
  blue: "var(--blue, #6f8cff)",
  white: "var(--ink, #ffffff)",
  dim: "color-mix(in srgb, var(--ink, #ffffff) 45%, transparent)",
  alert: "var(--alert, #ff3d7f)",
};

export type CreatureProps = {
  tier: TierId;
  /** CSS em size of one glyph row. */
  size?: number;
  tone?: CreatureTone;
  /** Mirror for left-facing. */
  flip?: boolean;
  label?: string;
  className?: string;
};

/** Reusable ASCII creature. Glyphs come from `app/assets/ocean` only. */
export function Creature({ tier, size = 0.85, tone = "lime", flip = false, label, className }: CreatureProps) {
  const lines = glyphOf(tier);
  const aria = label ?? tier;
  return (
    <pre
      className={className}
      aria-label={aria}
      title={aria}
      style={{
        margin: 0,
        padding: 0,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: `${size}rem`,
        lineHeight: 1.1,
        letterSpacing: "0.02em",
        color: TONE[tone],
        background: "transparent",
        transform: flip ? "scaleX(-1)" : undefined,
        display: "inline-block",
        whiteSpace: "pre",
        userSelect: "none",
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}
