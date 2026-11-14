// The permanent page for one planted headline: /i/<tx>. Its preview image is /api/card for the same transaction.
// Only text the chain holds for a landed attack is ever printed here: a refused or unverified headline is never
// rendered on this domain (lib/card.ts shownText), and a headline on the team's hide list gets no card.
import type { Metadata } from "next";
import { Suspense } from "react";
import { card } from "../../api/planted";
import { TX_RE } from "../../lib/card";
import { ResultView } from "./result-view";

type Props = { params: Promise<{ tx: string }>; searchParams: Promise<{ t?: string | string[] }> };
/** Deploy 16 only: the headline a share link carries, printed when its sha256 is the one on chain. */
const textOf = async (sp: Props["searchParams"]) => {
  const t = (await sp).t;
  return typeof t === "string" && t.trim() ? t.slice(0, 280) : null;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { tx } = await params;
  const c = TX_RE.test(tx) ? await card(tx, await textOf(searchParams)).catch(() => null) : null;
  // previews print the title and the image: only a headline the chain holds, and not one the team has hidden
  const text = c && !c.hidden ? c.text : null;
  const title = text ? `“${text}” · NearBuddy` : "A planted headline · NearBuddy";
  const description = "One fake headline, planted in a duel between two AIs on NEAR. Did the line bend?";
  const img = text && c?.record ? [{ url: `/api/card?tx=${encodeURIComponent(tx)}`, width: 1200, height: 630 }] : [];
  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, images: img },
    twitter: {
      card: img.length ? "summary_large_image" : "summary",
      title,
      description,
      images: img.map((i) => i.url),
    },
  };
}

async function Planted({ params, searchParams }: Props) {
  const { tx } = await params;
  if (!TX_RE.test(tx))
    return (
      <div className="page">
        <p>{`No planted headline in transaction ${tx.slice(0, 44)}.`}</p>
      </div>
    );
  const initial = await card(tx, await textOf(searchParams)).catch(() => null);
  return <ResultView tx={tx} initial={initial} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<div className="page" aria-busy="true" />}>
      <Planted {...props} />
    </Suspense>
  );
}
