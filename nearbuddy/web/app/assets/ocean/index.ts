export {
  TIERS,
  MIN_SAMPLE,
  TIER_CUTS,
  heldOf,
  rateOf,
  wilson,
  tierOf,
  mayEat,
  tierIndex,
  type TierId,
  type Resistance,
} from "./tiers";
export { GLYPHS, glyphOf, type Glyph } from "./glyphs";
export {
  SKIN_RAMP,
  EDGE_LIGHT,
  FIN_RAMP,
  MOSAIC_RAMP,
  MOSAIC,
  ACCENTS,
  glyphAt,
  mosaicGlyph,
  cellFill,
  cellInk,
  accentRgb,
  cellHash,
} from "./ramp";
export { sampleShark, samplePrey, sampleReef, toLocal, type Part } from "./shapes";
export { valueNoise2, fbm, ribbonDensity } from "./noise";
export {
  CELL_SIZE,
  ASCII_RAMP,
  allocBuffers,
  rasterizeOceanField,
  gaussianCount,
  type GridBuffers,
} from "./gaussian3d";
export {
  AmbientFauna,
  FAUNA_CAPS,
  FAUNA_CAPS_CALM,
  forceApexEntrance,
  type AmbientCreature,
  type FaunaBand,
} from "./fauna";
export {
  ArenaSimulation,
  seedFromBoard,
  tickFromRecent,
  multiplierOf,
  shortModelLabel,
  SIM_THINK_SEC,
  SIM_HELD_SEC,
  SIM_FOOLED_SEC,
  type BoardModelRow,
} from "./simulation";
export { catalogFromBoard } from "./catalog";
export {
  LOGO_SIZE,
  modelFamilyOf,
  logoStateOf,
  logoTimerOf,
  renderLogoGrid,
  type ModelFamily,
  type LogoState,
  type LogoSignal,
  type LogoRenderOpts,
} from "./ascii-model-logo";
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
