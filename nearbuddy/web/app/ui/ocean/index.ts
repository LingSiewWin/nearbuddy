export { Creature, type CreatureProps, type CreatureTone } from "./creature";
export { eatVerdict, type EatVerdict } from "./eat";
export { EatScene } from "./eat-scene";
export { AsciiOceanCanvas, type AsciiOceanCanvasProps } from "./ascii-ocean-canvas";
export { OceanArena, type OceanArenaProps } from "./ocean-arena";
export { DuelBetDock, type DuelBetDockProps } from "./duel-bet-dock";
export { AuditDrawer, type AuditDrawerProps } from "./audit-drawer";
export { AsciiModelLogo, type AsciiModelLogoProps } from "./ascii-model-logo";
export {
  TIERS,
  MIN_SAMPLE,
  heldOf,
  rateOf,
  wilson,
  tierOf,
  mayEat,
  glyphOf,
  GLYPHS,
  type TierId,
  type Resistance,
} from "../../assets/ocean";
export {
  ArenaSimulation,
  seedFromBoard,
  tickFromRecent,
  multiplierOf,
  shortModelLabel,
  type BoardModelRow,
} from "../../assets/ocean/simulation";
export { catalogFromBoard } from "../../assets/ocean/catalog";
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
