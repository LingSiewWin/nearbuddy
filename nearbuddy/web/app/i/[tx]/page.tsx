// The share page for one planted headline: /i/<tx>?t=<headline>. Its og:image is /api/card for the same tx and text,
// so a post on X shows the card; the page itself says what the chain confirms and links to the duel and its proofs.
import type { Metadata } from "next";
import { Suspense } from "react";
import { card } from "../../api/planted";
import { TX_RE } from "../../lib/card";
import { duelHref, near, short, txHref } from "../../tui";

type Props = { params: Promise<{ tx: string }>; searchParams: Promise<{ t?: string | string[] }> };
const textOf = async (sp: Props["searchParams"]) => {
  const t = (await sp).t;
  return typeof t === "string" && t.trim() ? t.slice(0, 280) : null;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { tx } = await params;
  const text = await textOf(searchParams);
  const img = `/api/card?tx=${encodeURIComponent(tx)}${text ? `&t=${encodeURIComponent(text)}` : ""}`;
  const title = text ? `“${text}” · Fool the AI` : "A planted headline · Fool the AI";
  const description = "One fake headline, planted in a live AI trading duel on NEAR. Did the model take the bait?";
  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, images: [{ url: img, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [img] },
  };
}

async function Planted({ params, searchParams }: Props) {
  const { tx } = await params;
  if (!TX_RE.test(tx)) return <pre className="bad">not a transaction hash</pre>;
  const text = await textOf(searchParams);
  const c = await card(tx, text);
  const p = c.planted;
  return (
    <pre className="wrap">
      <a href="/" className="dim">
        ← fool the AI
      </a>
      {"\n\n"}
      {p ? (
        <>
          <span className="dim">planted in </span>
          <span className="hi">{c.model ?? short(p.target, 8)}</span>
          <span className="dim"> · duel </span>
          <a href={duelHref(p.duel_id)}>#{p.duel_id}</a>
          <span className="dim"> · {near(p.deposit)} NEAR · by </span>
          {p.signer}
          {"\n\n"}
          {c.text ? (
            <span className="warn">“{c.text}”</span>
          ) : (
            <span className="dim">
              {text
                ? "this link's headline does not match the hash on chain, so it is not shown"
                : "no headline in this link"}
            </span>
          )}
          {"\n\n"}
          <span className={c.verdict === "fooled" ? "loss" : c.verdict === "held" ? "win" : "open"}>
            {c.verdict === "fooled"
              ? "FOOLED: its next call took the lie's side"
              : c.verdict === "held"
                ? "HELD: its next call did not take the lie's side"
                : "did it take the bait? its next call decides"}
          </span>
          {"\n\n"}
          <span className="dim">tx </span>
          <a href={txHref(tx)} target="_blank" rel="noreferrer">
            {tx}
          </a>
          <span className={p.landed ? "ok" : "bad"}>{p.landed ? "  on chain" : "  refused by the contract"}</span>
          {"\n"}
          <span className="dim">payload sha256 {p.payload_hash}</span>
          {c.text ? <span className="ok"> = sha256 of the headline above</span> : null}
          {"\n\n"}
          <a href={duelHref(p.duel_id)}>verify duel #{p.duel_id} yourself</a>
        </>
      ) : (
        <span className="dim">
          transaction {short(tx, 12)} is not an injection the indexer knows yet; a fresh one takes a few seconds
        </span>
      )}
    </pre>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<pre className="dim">reading the transaction</pre>}>
      <Planted {...props} />
    </Suspense>
  );
}
