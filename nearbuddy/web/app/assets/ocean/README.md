# Ocean assets

Pure data + engines for NearBuddy's ASCII arena. No React, no fetch.

| Path | Role |
|---|---|
| `tiers.ts` | `TierId`, resistance → tier, Wilson, eat gate |
| `glyphs/*.ts` | Compact outline frames for small `<Creature />` marks |
| `fauna.ts` | Decorative ecosystem school + periodic large/apex (not board models) |
| `gaussian3d.ts` | **Hero rasterizer:** 3D Gaussian duelists + 2D fauna stamps → ASCII grid |
| `simulation.ts` | Reynolds seek/flee, 2-slot duel, sim round / sim stake, owns `AmbientFauna` |
| `catalog.ts` | `board.json` rows → selectable `ModelSpec[]` |
| `arena-types.ts` | Creature / tick / theme types |
| `shapes.ts` / `ramp.ts` / `noise.ts` | Silhouettes (`sampleReef` / prey / shark) + mosaic helpers |
| `sdf.ts` | Legacy 2D SDF rasterizer (unwired; superseded by `gaussian3d`) |

### Fauna population caps (homepage FPS)

| Band | Full motion | `prefers-reduced-motion` | Notes |
|---|---|---|---|
| tiny (shrimp/crab/nemo) | 40 | 14 | 3 clustered flocks, Reynolds |
| mid (fish/dolphin) | 5 | 2 | Ambient mid fish |
| large (shark) | ≤1 | 0 | First ~3s, then every ~10–18s |
| apex (megalodon) | ≤1 | 0 | First ~18s, then every ~40–75s |

Duelists (board models) stay separate: 2 Gaussian heroes. Ambient actors never claim LIVE outsider money.

UI: `ui/ocean/` (`OceanArena`, canvas, dock, audit drawer). Pages import `ui/ocean` only.
