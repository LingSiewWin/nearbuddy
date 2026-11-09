"use client";
import { useEffect, useRef, useState } from "react";
import type { Config, Mandate, Solver, Vault } from "../lib/abi/vault";
import { bottom, boxTitle, near, row, W } from "../tui";

type Snap = {
  at: number;
  rpc: string;
  contract: string;
  owner: string;
  solverId: string;
  api: string;
  // vault views, passed through unchanged by /api/state
  config: Config | null;
  vault: Vault | null;
  solver: Solver | null;
  mandate: Mandate | null;
  apiBalance: string | null;
  ledger: { carrying: number; exposure: { agent_pk: string; yocto: string }[] } | null;
};

/** 5 decimals: a call costs 0.00005 NEAR, which the arena's 3-decimal default would print as 0.000. */
const near5 = (y: string | null | undefined) => near(y, 5);

export default function Page() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [agentPk, setAgentPk] = useState("");
  const prev = useRef<Snap | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = (await (
          await fetch(`/api/state${agentPk ? `?agent_pk=${encodeURIComponent(agentPk)}` : ""}`, { cache: "no-store" })
        ).json()) as Snap;
        if (!alive) return;
        const p = prev.current;
        const t = new Date(s.at).toISOString().slice(11, 19);
        const lines: string[] = [];
        if (p?.ledger && s.ledger && s.ledger.carrying !== p.ledger.carrying)
          lines.push(`${t}  solver carrying ${p.ledger.carrying} -> ${s.ledger.carrying} IOUs`);
        if (p?.vault && s.vault && s.vault.balance !== p.vault.balance)
          lines.push(`${t}  vault ${near5(p.vault.balance)} -> ${near5(s.vault.balance)} NEAR  (settlement landed)`);
        if (p?.solver && s.solver && s.solver.ious_settled !== p.solver.ious_settled)
          lines.push(
            `${t}  solver lifetime IOUs ${p.solver.ious_settled} -> ${s.solver.ious_settled}, fees ${near5(s.solver.fees_earned)} NEAR`,
          );
        if (lines.length) setLog((l) => [...l, ...lines].slice(-30));
        prev.current = s;
        setSnap(s);
      } catch {
        /* keep last snapshot */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [agentPk]);

  const s = snap;
  const exposure = s?.ledger?.exposure.reduce((a, e) => a + BigInt(e.yocto), 0n) ?? 0n;
  return (
    <pre>
      <span className="hi">NEARBUDDY</span>{" "}
      <span className="dim">· zero-balance credit clearinghouse for AI agents · NEAR testnet · live</span>
      {"\n"}
      <span className="dim">
        {s ? `snapshot ${new Date(s.at).toISOString()}  rpc ${new URL(s.rpc).host}` : "connecting"}
      </span>
      <span className="cursor" />
      {"\n\n"}
      {boxTitle(1, "contract")}
      {"\n"}
      {row("account", s?.contract ?? "-")}
      {"\n"}
      {row("fee", s?.config ? `${s.config.fee_bps} bps of settled volume -> solver` : "-")}
      {"\n"}
      {row(
        "withdraw delay",
        s?.config
          ? `${Number(s.config.withdraw_delay_ns) / 1e9} s (solvers decline new IOUs while a withdrawal is pending)`
          : "-",
      )}
      {"\n"}
      {row("max batch", s?.config ? `${s.config.max_batch} IOUs per settle_batch` : "-")}
      {"\n"}
      {bottom()}
      {"\n\n"}
      {boxTitle(2, "owner vault")}
      {"\n"}
      {row("owner", s?.owner ?? "-")}
      {"\n"}
      {row("locked", `${near5(s?.vault?.balance)} NEAR`)}
      {"\n"}
      {row(
        "withdraw",
        s?.vault?.pending_withdraw ? `PENDING ${near5(s.vault.pending_withdraw[0])} NEAR` : "none pending",
      )}
      {"\n"}
      {bottom()}
      {"\n\n"}
      {boxTitle(3, "solver")}
      {"\n"}
      {row("solver", s?.solverId ?? "-")}
      {"\n"}
      {row("stake", `${near5(s?.solver?.stake)} NEAR`)}
      {"\n"}
      {row("fees earned", `${near5(s?.solver?.fees_earned)} NEAR`)}
      {"\n"}
      {row("IOUs settled", `${s?.solver?.ious_settled ?? "-"} lifetime`)}
      {"\n"}
      {row(
        "carrying now",
        s?.ledger
          ? `${s.ledger.carrying} unsettled IOUs, exposure ${near5(exposure.toString())} NEAR  ${"▮".repeat(Math.min(60, s.ledger.carrying))}`
          : "solver offline (start: pnpm solver)",
      )}
      {"\n"}
      {bottom()}
      {"\n\n"}
      {boxTitle(4, "payee", "paid API")}
      {"\n"}
      {row("account", s?.api ?? "-")}
      {"\n"}
      {row("balance", `${near5(s?.apiBalance)} NEAR`)}
      {"\n"}
      {bottom()}
      {"\n\n"}
      {boxTitle(5, "mandate")}
      {"\n"}
      <span>│ agent key </span>
      <input
        value={agentPk}
        onChange={(e) => setAgentPk(e.target.value.trim())}
        placeholder="paste base64 agent_pk from the demo (step 3)"
        style={{
          width: "60ch",
          background: "transparent",
          color: "inherit",
          border: "1px dashed var(--dim)",
          font: "inherit",
          padding: "0 4px",
        }}
      />
      {"\n"}
      {row(
        "allowance",
        s?.mandate
          ? `${near5(s.mandate.spent)} spent / ${near5(s.mandate.allowance)} NEAR`
          : agentPk
            ? "no mandate for that key"
            : "-",
      )}
      {"\n"}
      {row("per-IOU cap", s?.mandate ? `${near5(s.mandate.per_tx_cap)} NEAR` : "-")}
      {"\n"}
      {row("payees", s?.mandate ? s.mandate.allowed_payees.join(", ") || "any" : "-")}
      {"\n"}
      {row(
        "status",
        s?.mandate
          ? s.mandate.revoked
            ? "REVOKED"
            : `active until ${new Date(Number(BigInt(s.mandate.expires_at) / 1_000_000n)).toISOString()}`
          : "-",
      )}
      {"\n"}
      {bottom()}
      {"\n\n"}
      {boxTitle(6, "events", "observed by this page")}
      {"\n"}
      {log.length
        ? log.map((l) => `│ ${l.padEnd(W - 4)} │`).join("\n")
        : row("", "run `CALLS=100 pnpm demo` in nearbuddy/ and watch this fill")}
      {"\n"}
      {bottom()}
      {"\n\n"}
      <span className="dim">
        how it works: agent (keypair, 0 NEAR) → GET → 402 → signs IOU → solver underwrites in ms → 200 … ×N → solver
        settle_batch = 1 tx
      </span>
      {"\n"}
      <span className="dim">arena (models duel, get attacked, get followed under mandates): </span>
      <a href="/arena" className="hi">
        /arena
      </a>
    </pre>
  );
}
