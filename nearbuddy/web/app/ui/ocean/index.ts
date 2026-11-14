export {
  GLYPHS,
  glyphOf,
  heldOf,
  MIN_SAMPLE,
  mayEat,
  type Resistance,
  rateOf,
  TIERS,
  type TierId,
  tierOf,
  wilson,
} from "../../assets/ocean";
export type {
  ArenaTheme,
  CreatureBody,
  DecisionTick,
  ModelAgentState,
  ModelSeed,
  ModelSpec,
  PredationRipple,
  SimStake,
} from "../../assets/ocean/arena-types";
export { catalogFromBoard } from "../../assets/ocean/catalog";
export {
  ArenaSimulation,
  type BoardModelRow,
  multiplierOf,
  seedFromBoard,
  shortModelLabel,
  tickFromRecent,
} from "../../assets/ocean/simulation";
export { AsciiModelLogo, type AsciiModelLogoProps } from "./ascii-model-logo";
export { AsciiOceanCanvas, type AsciiOceanCanvasProps } from "./ascii-ocean-canvas";
export { AuditDrawer, type AuditDrawerProps } from "./audit-drawer";
export { Creature, type CreatureProps, type CreatureTone } from "./creature";
export { DuelBetDock, type DuelBetDockProps } from "./duel-bet-dock";
export { type EatVerdict, eatVerdict } from "./eat";
export { EatScene } from "./eat-scene";
export { OceanArena, type OceanArenaProps } from "./ocean-arena";
