export type {
  ArenaTheme,
  CreatureBody,
  DecisionTick,
  ModelAgentState,
  ModelSeed,
  ModelSpec,
  PredationRipple,
  SimStake,
} from "./arena-types";
export {
  LOGO_SIZE,
  type LogoRenderOpts,
  type LogoSignal,
  type LogoState,
  logoStateOf,
  logoTimerOf,
  type ModelFamily,
  modelFamilyOf,
  renderLogoGrid,
} from "./ascii-model-logo";
export { catalogFromBoard } from "./catalog";
export {
  type AmbientCreature,
  AmbientFauna,
  FAUNA_CAPS,
  FAUNA_CAPS_CALM,
  type FaunaBand,
  forceApexEntrance,
} from "./fauna";
export {
  ASCII_RAMP,
  allocBuffers,
  CELL_SIZE,
  type GridBuffers,
  gaussianCount,
  rasterizeOceanField,
} from "./gaussian3d";
export { GLYPHS, type Glyph, glyphOf } from "./glyphs";
export { fbm, ribbonDensity, valueNoise2 } from "./noise";
export {
  ACCENTS,
  accentRgb,
  cellFill,
  cellHash,
  cellInk,
  EDGE_LIGHT,
  FIN_RAMP,
  glyphAt,
  MOSAIC,
  MOSAIC_RAMP,
  mosaicGlyph,
  SKIN_RAMP,
} from "./ramp";
export { type Part, samplePrey, sampleReef, sampleShark, toLocal } from "./shapes";
export {
  ArenaSimulation,
  type BoardModelRow,
  multiplierOf,
  SIM_FOOLED_SEC,
  SIM_HELD_SEC,
  SIM_THINK_SEC,
  seedFromBoard,
  shortModelLabel,
  tickFromRecent,
} from "./simulation";
export {
  heldOf,
  MIN_SAMPLE,
  mayEat,
  type Resistance,
  rateOf,
  TIER_CUTS,
  TIERS,
  type TierId,
  tierIndex,
  tierOf,
  wilson,
} from "./tiers";
