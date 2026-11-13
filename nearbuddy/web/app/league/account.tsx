// The account bar: who this visitor is on the page. With no account it offers a guest account (lib/guest.ts: made in
// one click, its key kept in this browser, funded with testnet NEAR) or a wallet. A guest is told what it is, and
// leaving asks first, because it drops the key.
import { useState } from "react";
import { recall } from "../lib/guest";
import * as wallet from "../lib/wallet";
import { NETWORK_ID } from "../tui";

export function AccountBar({ account, onAccount }: { account: string | null; onAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const guest = account !== null && recall()?.accountId === account;

  const run = async (f: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      onAccount(await f());
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };
  const leave = () => {
    if (
      guest &&
      !window.confirm("Leave this guest account? Its key is deleted from this browser and cannot be recovered.")
    )
      return;
    run(async () => {
      await wallet.signOut();
      return null;
    });
  };

  return (
    <div id="account" className="account">
      {account ? (
        <>
          <span>{guest ? `guest ${account}` : account}</span>
          {guest ? <span className="dim">a temporary testnet account; its key lives in this browser only</span> : null}
          <button type="button" className="link" onClick={leave} disabled={busy}>
            leave
          </button>
        </>
      ) : (
        <>
          {NETWORK_ID === "testnet" ? (
            <button type="button" onClick={() => run(() => wallet.guestSignIn())} disabled={busy}>
              {busy ? "making your account…" : "play as guest"}
            </button>
          ) : null}
          <button type="button" className="link" onClick={() => run(() => wallet.signIn())} disabled={busy}>
            connect a wallet
          </button>
          <span className="dim">
            {NETWORK_ID === "testnet"
              ? "a guest account takes a few seconds: no wallet, no sign-up, free testnet NEAR"
              : "connect a NEAR wallet to comment or shout"}
          </span>
        </>
      )}
      {note ? <span className="warn">{note}</span> : null}
    </div>
  );
}
