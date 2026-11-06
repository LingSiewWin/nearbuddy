# Vendored stageshow kit (subset)

The parts of the stageshow kit that the `/how` explainer uses:
the stage and its script runtime, `Bar`, `Collapse`, `Roll`, `Stream` and `Icon`.

stageshow, MIT, Copyright (c) 2026 Benji Taylor. The license is in `LICENSE` in this folder.

Changes from upstream: unused parts and the product brand artwork are left out, and `act.ts`,
`measure.ts` and `stage.tsx` carry `// @ts-nocheck` because this app's tsconfig adds
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, which upstream is not written for.
