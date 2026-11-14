"use client";
// Audit drawer for a selected model — held/tested + sim ticks; links to /board. No fake 0x sigs.
import type { ArenaTheme, CreatureBody } from "../../assets/ocean/arena-types";

export type AuditDrawerProps = {
  model: CreatureBody | null;
  theme: ArenaTheme;
  onClose: () => void;
};

export function AuditDrawer({ model, theme, onClose }: AuditDrawerProps) {
  if (!model) return null;
  const isDark = theme === "dark";
  return (
    <aside className={`ocean-audit ocean-audit-${isDark ? "dark" : "light"}`} aria-label={`Audit ${model.label}`}>
      <div className="ocean-audit-head">
        <div className="ocean-audit-head-text">
          <div className="ocean-audit-title" title={model.modelId}>
            {model.label}
          </div>
          <div className="ocean-audit-sub">{model.modelId}</div>
        </div>
        <button type="button" className="ocean-audit-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <dl className="ocean-audit-stats">
        <div>
          <dt>Held</dt>
          <dd>{`${model.held} of ${model.tested}`}</dd>
        </div>
        <div>
          <dt>Fooled</dt>
          <dd>{model.fooled}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{model.tier}</dd>
        </div>
      </dl>
      <a className="ocean-audit-link" href="/board">
        Open full board →
      </a>
      <div className="ocean-audit-label">Recent ticks</div>
      <div className="ocean-audit-list">
        {model.recentEvents.length === 0 ? (
          <p className="ocean-audit-empty">No ticks yet. Run a round or wait for the next stream.</p>
        ) : (
          model.recentEvents.slice(0, 8).map((evt) => (
            <div key={evt.id} className="ocean-audit-row">
              <span className={evt.wasFooled ? "is-fooled" : "is-held"}>{evt.wasFooled ? "fooled" : "held"}</span>
              {evt.duelId ? <span className="ocean-audit-duel">duel #{evt.duelId}</span> : null}
              {evt.promptHint ? <p className="ocean-audit-hint">{evt.promptHint}</p> : null}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
