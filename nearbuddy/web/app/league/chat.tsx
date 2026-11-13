// The chat box under the feed: free comments from signed-in visitors on the shown match. Signing in asks the wallet
// to sign one NEP-413 message (not a transaction, no cost); the server answers with a session cookie. A comment is
// for people: it never reaches a model (a paid shout does, through the contract).
import { useState } from "react";
import { type Comment, clean, loginMessage, MAX_COMMENT, newNonce } from "../lib/comments";
import * as wallet from "../lib/wallet";

export type Session = { available: boolean; account: string | null };

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function Chat({
  duel,
  session,
  onSession,
  onPosted,
}: {
  /** The shown match, or "" with none. */
  duel: string;
  session: Session;
  onSession: (s: Session) => void;
  onPosted: (c: Comment) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!session.available || !duel) return null;

  const fail = (e: unknown) => setNote(String(e instanceof Error ? e.message : e).slice(0, 200));
  async function signIn() {
    setBusy(true);
    setNote(null);
    try {
      if (!(await wallet.account())) await wallet.signIn();
      const nonce = newNonce(Date.now());
      const s = await wallet.signMessage({ message: loginMessage(location.host), recipient: location.host, nonce });
      const r = await fetch("/api/league/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: s.accountId,
          publicKey: s.publicKey,
          signature: s.signature,
          nonce: b64(nonce),
        }),
      });
      const j = (await r.json()) as { account?: string; error?: string };
      if (!r.ok || !j.account) throw new Error(j.error ?? `HTTP ${r.status}`);
      onSession({ available: true, account: j.account });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    const ok = clean(text);
    if ("error" in ok) return setNote(ok.error);
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/league/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duel, text: ok.text }),
      });
      const j = (await r.json()) as { comment?: Comment; error?: string };
      if (r.status === 401) onSession({ available: true, account: null });
      if (!r.ok || !j.comment) throw new Error(j.error ?? `HTTP ${r.status}`);
      setText("");
      onPosted(j.comment);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    await fetch("/api/league/session", { method: "DELETE" }).catch(() => {});
    onSession({ available: true, account: null });
  }

  return (
    <div id="chat" className="chat">
      {session.account ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && text.trim()) send();
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="say something"
            aria-label="Comment"
            maxLength={MAX_COMMENT}
          />
          <button type="submit" disabled={busy || !text.trim()}>
            send
          </button>
          <p className="dim">
            {`free, for people only: a model never reads it · as ${session.account} · `}
            <button type="button" className="link" onClick={signOut}>
              sign out of chat
            </button>
          </p>
        </form>
      ) : (
        <button type="button" onClick={signIn} disabled={busy}>
          {busy ? "waiting for your wallet…" : "sign in to comment"}
        </button>
      )}
      {note ? <p className="warn">{note}</p> : null}
    </div>
  );
}
