// The shout box under the feed: plant one paid headline at a side of the live match. It is the arena's inject_chaos
// (lib/inject.ts builds the call, the connected wallet signs it): the model reads the headline before its next call,
// and the contract settles whether it took the bait. Paid and at risk, and the box says so before anything is signed.
import { useState } from "react";
import type { Match } from "../api/league";
import { chaosDeploy17, checkHeadline, type Direction, MAX_HEADLINE, utf8Bytes } from "../lib/inject";
import * as wallet from "../lib/wallet";
import { near } from "../tui";

export function Shout({
  live,
  contract,
  fee,
  account,
  onAccount,
}: {
  live: Match | null;
  contract: string | null;
  /** The live match's next shout price in yoctoNEAR (chaos_fee), or null while unread. */
  fee: string | null;
  account: string | null;
  onAccount: (a: string | null) => void;
}) {
  const [target, setTarget] = useState<"A" | "B">("A");
  const [kind, setKind] = useState<Direction>("Long");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ c: string; t: string } | null>(null);

  if (!live || !contract)
    return (
      <div id="shout" className="shout">
        <p className="dim">shouts open when a match is live</p>
      </div>
    );
  const price = fee ? `${near(fee)} NEAR` : "price unread";
  const bad = text ? checkHeadline(text) : null;

  async function connect() {
    setNote(null);
    try {
      onAccount(await wallet.signIn());
    } catch (e) {
      setNote({ c: "warn", t: String(e instanceof Error ? e.message : e).slice(0, 160) });
    }
  }
  async function send(m: Match) {
    setBusy(true);
    setNote(null);
    try {
      const call = await chaosDeploy17.prepare(
        { duel_id: m.id, target: target === "A" ? m.a.pk : m.b.pk, text, kind },
        { contract: contract as string, min_chaos_deposit: "0", chaos_fee: fee },
      );
      const tx = await wallet.send(call); // throws when the wallet declines or the contract refuses
      setText("");
      setNote({ c: "ok", t: `planted · tx ${tx.slice(0, 10)}…` });
    } catch (e) {
      setNote({ c: "warn", t: String(e instanceof Error ? e.message : e).slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="shout" className="shout">
      <p className="dim">
        {`shout at a model: a paid headline it reads before its next call · ${price} · you get the stake back less a fee with a share of its bond if it takes the bait and loses; if it holds, it keeps your stake`}
      </p>
      {account ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && text && !bad) send(live);
          }}
        >
          <select value={target} onChange={(e) => setTarget(e.target.value as "A" | "B")} aria-label="Which model">
            <option value="A">{`at ${live.a.model}`}</option>
            <option value="B">{`at ${live.b.model}`}</option>
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as Direction)} aria-label="Which way it pushes">
            <option value="Long">pushes it long</option>
            <option value="Short">pushes it short</option>
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="your headline"
            aria-label="Headline"
            maxLength={MAX_HEADLINE}
          />
          <button type="submit" disabled={busy || !text || !!bad || !fee}>
            {busy ? "signing…" : `shout · ${price}`}
          </button>
          {bad ? <p className="warn">{bad}</p> : null}
          {text ? <p className="dim">{`${utf8Bytes(text)}/${MAX_HEADLINE} bytes · signed by ${account}`}</p> : null}
        </form>
      ) : (
        <button type="button" onClick={connect}>
          connect a wallet to shout
        </button>
      )}
      {note ? <p className={note.c}>{note.t}</p> : null}
    </div>
  );
}
