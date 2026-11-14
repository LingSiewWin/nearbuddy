"use client";
// Full-bleed connect gate: Meteor / NEAR wallet, plus guest on testnet. No email, no Google.
import { useEffect, useId, useRef, useState } from "react";
import * as wallet from "../lib/wallet";
import { NETWORK_ID } from "../network";
import { StatusBar } from "./kit";

export type WalletSignInProps = {
  open: boolean;
  onDone: (account: string | null) => void;
};

const MeteorMark = () => (
  <svg className="wallet-gate-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M7 14.5c2.2-1.2 3.6-3.2 4.2-5.8.4 2.2 1.6 4 3.6 5.2-2.4.2-4.2 1.2-5.6 2.8-.6-1-.8-1.5-2.2-2.2z"
      fill="currentColor"
    />
  </svg>
);

export function WalletSignIn({ open, onDone }: WalletSignInProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState<"guest" | "wallet" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      setError(null);
      setBusy(null);
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  const run = async (which: "guest" | "wallet") => {
    setBusy(which);
    setError(null);
    const el = dialog.current;
    // showModal() puts this dialog in the browser top layer, above Near Connect's
    // body popup (z-index 1e8). Leave the top layer while the picker is open.
    if (which === "wallet") el?.close();
    try {
      const a = which === "guest" ? await wallet.guestSignIn() : await wallet.signIn();
      if (a) onDone(a);
      else if (which === "wallet" && open) el?.showModal();
    } catch {
      if (which === "guest") {
        setError("Could not make a guest account. The test faucet did not answer. Try again, or connect a wallet.");
      } else {
        setError("Wallet did not connect. Pick Meteor (or another NEAR wallet) and try again.");
        if (open) el?.showModal();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes on the backdrop; the keyboard path is Escape, handled by onCancel
    <dialog
      ref={dialog}
      className="wallet-gate"
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (busy === "guest") e.preventDefault();
        else onDone(null);
      }}
      onClick={(e) => {
        if (e.target === dialog.current && busy !== "guest") onDone(null);
      }}
    >
      <div className="wallet-gate-frame">
        <section className="wallet-gate-form">
          <button
            type="button"
            className="wallet-gate-close"
            aria-label="Close"
            disabled={busy === "guest"}
            onClick={() => onDone(null)}
          >
            ×
          </button>
          <div className="wallet-gate-copy">
            <p className="wallet-gate-kicker">NearBuddy</p>
            <h2 id={titleId} className="wallet-gate-title">
              Connect to enter the arena
            </h2>
            <p className="wallet-gate-lede">
              Use your NEAR wallet to plant attacks, lock a bond, or claim. Meteor works as a browser extension.
            </p>
          </div>

          {error ? <StatusBar kind="error">{error}</StatusBar> : null}

          <div className="wallet-gate-actions">
            <button
              type="button"
              className="wallet-gate-primary"
              disabled={busy !== null}
              onClick={() => run("wallet")}
            >
              {busy === "wallet" ? (
                "Waiting for wallet…"
              ) : (
                <>
                  <MeteorMark />
                  Connect wallet
                </>
              )}
            </button>
            <p className="wallet-gate-hint">Meteor, Intear, and other NEAR wallets via the picker.</p>

            {NETWORK_ID === "testnet" ? (
              <>
                <div className="wallet-gate-or">
                  <span>or</span>
                </div>
                <button
                  type="button"
                  className="wallet-gate-secondary"
                  disabled={busy !== null}
                  onClick={() => run("guest")}
                >
                  {busy === "guest" ? "Making your account…" : "Play as guest"}
                </button>
                <p className="wallet-gate-hint">Temporary test account in this browser. No wallet needed.</p>
              </>
            ) : null}
          </div>
        </section>

        <aside className="wallet-gate-hero" aria-hidden="true">
          <div className="wallet-gate-hero-panel">
            <div className="wallet-gate-hero-grid" />
            <p className="wallet-gate-hero-line">A public stress test for AI trading agents.</p>
            <p className="wallet-gate-hero-sub">Bonded. Open to attack. Every decision signed in an enclave.</p>
          </div>
        </aside>
      </div>
    </dialog>
  );
}
