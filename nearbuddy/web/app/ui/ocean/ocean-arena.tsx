"use client";
// Hero battle surface: 3D Gaussian ASCII + theme toggle + 2-model dock + audit drawer.
import { useCallback, useMemo, useState } from "react";
import type { ArenaTheme, ModelAgentState, ModelSpec } from "../../assets/ocean/arena-types";
import { catalogFromBoard } from "../../assets/ocean/catalog";
import { ArenaSimulation, seedFromBoard, type BoardModelRow } from "../../assets/ocean/simulation";
import { useReducedMotion } from "../trace-view";
import { AsciiOceanCanvas } from "./ascii-ocean-canvas";
import { AuditDrawer } from "./audit-drawer";
import { DuelBetDock } from "./duel-bet-dock";

export type OceanArenaProps = {
  models: BoardModelRow[];
  datasetRows?: number;
  /** Prefer strongest vs weakest by resistance for the opening duel. */
  className?: string;
};

function pickOpeningPair(catalog: ModelSpec[]): [ModelSpec, ModelSpec] | null {
  if (catalog.length < 2) return null;
  const ranked = [...catalog].sort((a, b) => b.baseResilience - a.baseResilience);
  return [ranked[0]!, ranked[ranked.length - 1]!];
}

export function OceanArena({ models, datasetRows = 0, className }: OceanArenaProps) {
  const catalog = useMemo(() => catalogFromBoard(models), [models]);
  const seeds = useMemo(() => seedFromBoard(models), [models]);
  const simulation = useMemo(() => {
    const sim = new ArenaSimulation(800, 520, [], datasetRows, catalog);
    const pair = pickOpeningPair(catalog);
    if (pair) sim.setDuelModels(pair[0], pair[1]);
    else if (seeds.length) sim.initFromSeeds(seeds.slice(0, 2));
    return sim;
  }, [catalog, seeds, datasetRows]);

  const calm = useReducedMotion();
  const thinkSec = calm ? 0 : undefined;
  const [theme, setTheme] = useState<ArenaTheme>("dark");
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);

  const left = simulation.creatures[0];
  const right = simulation.creatures[1];
  const inspected =
    simulation.creatures.find((c) => c.modelId === inspectedId) ?? null;

  const onSelect = (m: ModelAgentState | null) => {
    setInspectedId(m ? m.modelId : null);
    bump();
  };

  return (
    <div className={`ocean-arena ocean-arena-${theme}${className ? ` ${className}` : ""}`}>
      <AsciiOceanCanvas
        simulation={simulation}
        theme={theme}
        selectedModelId={inspectedId}
        onSelectModel={onSelect}
        onTickHud={bump}
      />

      <header className="ocean-pill">
        <span className="ocean-pill-dot" aria-hidden />
        <span>
          <strong>{datasetRows.toLocaleString("en-US")}</strong> signed decisions on record
        </span>
        <span className="ocean-pill-sep" aria-hidden>
          |
        </span>
        <button
          type="button"
          onClick={() => {
            simulation.triggerSimRound(undefined, 0, thinkSec);
            bump();
          }}
        >
          Sim round
        </button>
        <span className="ocean-pill-sep" aria-hidden>
          |
        </span>
        <button type="button" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? "Light grid" : "Abyssal dark"}
        </button>
      </header>

      <AuditDrawer model={inspected} theme={theme} onClose={() => setInspectedId(null)} />

      {left && right ? (
        <DuelBetDock
          leftModel={left}
          rightModel={right}
          catalog={catalog}
          theme={theme}
          onSwapModel={(slot, spec) => {
            simulation.swapSlotModel(slot, spec);
            bump();
          }}
          onPlaceSimStake={(id, stake) => {
            simulation.placeSimStake(id, stake, thinkSec);
            bump();
          }}
          onInspectModel={(m) => {
            setInspectedId(m.modelId);
            bump();
          }}
        />
      ) : null}
    </div>
  );
}
