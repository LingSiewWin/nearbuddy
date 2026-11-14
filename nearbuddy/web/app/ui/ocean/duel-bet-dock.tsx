"use client";
// Frosted 2-model duel dock. Stake chips drive the local sim only — not on-chain payouts.
import { useState, type FormEvent } from "react";
import type { ArenaTheme, CreatureBody, ModelSpec } from "../../assets/ocean/arena-types";

const TIER_LABELS: Record<string, string> = {
  shrimp: "shrimp",
  crab: "crab",
  fish: "fish",
  dolphin: "dolphin",
  shark: "shark",
  megalodon: "megalodon",
};

const CHIPS = [10, 25, 50, 100];

export type DuelBetDockProps = {
  leftModel: CreatureBody;
  rightModel: CreatureBody;
  catalog: ModelSpec[];
  theme: ArenaTheme;
  onSwapModel: (slot: 0 | 1, spec: ModelSpec) => void;
  onPlaceSimStake: (modelId: string, stake: number) => void;
  onInspectModel: (model: CreatureBody) => void;
};

export function DuelBetDock({
  leftModel,
  rightModel,
  catalog,
  theme,
  onSwapModel,
  onPlaceSimStake,
  onInspectModel,
}: DuelBetDockProps) {
  const [side, setSide] = useState<0 | 1>(0);
  const [stake, setStake] = useState("25");
  const isDark = theme === "dark";
  const active = side === 0 ? leftModel : rightModel;
  const stakeNum = Math.max(0, Number(stake) || 0);
  const odds = (1 / Math.max(0.08, active.poolShare)).toFixed(2);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stakeNum <= 0) return;
    onPlaceSimStake(active.modelId, stakeNum);
  };

  const card = (model: CreatureBody, slot: 0 | 1) => {
    const chosen = side === slot;
    const heldPct = ((model.held / Math.max(1, model.tested)) * 100).toFixed(0);
    const odds = (1 / Math.max(0.08, model.poolShare)).toFixed(2);
    return (
      <div
        key={model.modelId}
        className={`ocean-dock-card${chosen ? " is-chosen" : ""}`}
        onClick={() => setSide(slot)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setSide(slot);
        }}
        role="button"
        tabIndex={0}
      >
        <div className="ocean-dock-card-row">
          <div className="ocean-dock-card-main">
            <div className="ocean-dock-card-top">
              <select
                value={model.modelId}
                aria-label={slot === 0 ? "Left model" : "Right model"}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const found = catalog.find((m) => m.modelId === e.target.value);
                  if (found) onSwapModel(slot, found);
                }}
              >
                {catalog.map((spec) => (
                  <option key={spec.modelId} value={spec.modelId}>
                    {spec.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ocean-dock-tier"
                onClick={(e) => {
                  e.stopPropagation();
                  onInspectModel(model);
                }}
              >
                {TIER_LABELS[model.tier] ?? model.tier} · {model.multiplier.toFixed(2)}×
              </button>
            </div>
            <div className="ocean-dock-card-stats">
              <span>
                Held <strong>{heldPct}%</strong>
              </span>
              <span>odds {odds}×</span>
              <span>
                {model.held}/{model.tested}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`ocean-dock ocean-dock-${isDark ? "dark" : "light"}`}>
      <div className="ocean-dock-fighters">
        {card(leftModel, 0)}
        <span className="ocean-dock-vs">vs</span>
        {card(rightModel, 1)}
      </div>
      <form className="ocean-dock-bet" onSubmit={submit}>
        <div className="ocean-dock-chips">
          {CHIPS.map((n) => (
            <button key={n} type="button" className={stake === String(n) ? "is-on" : undefined} onClick={() => setStake(String(n))}>
              {n}
            </button>
          ))}
          <input
            type="number"
            min={1}
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            aria-label="Sim stake amount"
          />
        </div>
        <p className="ocean-dock-note">
          Sim stake on <strong>{active.label}</strong> · pool weight {odds}× — kinematics only, not a NEAR payout.{" "}
          <a href="/enter">Enter a real agent</a> or <a href="/board">audit counts</a>.
        </p>
        <button type="submit" className="ocean-dock-go">
          Run sim round
        </button>
      </form>
    </div>
  );
}
