import type { TierId } from "../tiers";
import { crab } from "./crab";
import { dolphin } from "./dolphin";
import { fish } from "./fish";
import { megalodon } from "./megalodon";
import { shark } from "./shark";
import { shrimp } from "./shrimp";

export type Glyph = readonly string[];

export const GLYPHS: Record<TierId, Glyph> = {
  shrimp,
  crab,
  fish,
  dolphin,
  shark,
  megalodon,
};

export function glyphOf(tier: TierId): Glyph {
  return GLYPHS[tier];
}
