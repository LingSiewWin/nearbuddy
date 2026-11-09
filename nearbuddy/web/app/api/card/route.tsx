// GET /api/card?tx=<inject_chaos tx>&t=<headline>: the 1200x630 share image for one planted headline. Everything on it
// comes from the chain (duel, target, deposit, signer) except the headline, which is printed only when its sha256 is
// the payload_hash that tx put on chain; a link with any other text gets a card without it.
import { ImageResponse } from "next/og";
import { TX_RE } from "../../lib/card";
import { NETWORK_ID } from "../../network";
import { near, short } from "../../tui";
import { card } from "../planted";

const C = {
  bg: "#0b0f0c",
  fg: "#c8f5c8",
  dim: "#5f8a5f",
  hi: "#eaffea",
  warn: "#f5d76e",
  bad: "#ff7b72",
  ok: "#7ee787",
};

/** Geist Mono for the card's terminal look, cut to the glyphs it prints; null (Geist, bundled) when Google Fonts fails. */
async function mono(text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=Geist+Mono:wght@500&text=${encodeURIComponent(text)}`, {
        signal: AbortSignal.timeout(3000),
      })
    ).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    return url ? await (await fetch(url, { signal: AbortSignal.timeout(3000) })).arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const tx = q.get("tx") ?? "";
  if (!TX_RE.test(tx)) return new Response("tx must be a transaction hash", { status: 400 });
  const c = await card(tx, (q.get("t") ?? "").slice(0, 280) || null);
  const p = c.planted;
  const verdict =
    c.verdict === "fooled"
      ? { t: "FOOLED: it took the bait", c: C.bad }
      : c.verdict === "held"
        ? { t: "HELD: it did not take the bait", c: C.ok }
        : { t: "did it take the bait?", c: C.warn };
  const lines = {
    top: `FOOL THE AI · NEAR ${NETWORK_ID}`,
    target: p
      ? `planted in ${c.model ?? short(p.target, 8)} · duel #${p.duel_id} · ${near(p.deposit)} NEAR`
      : "transaction not found yet",
    text: c.text ? `"${c.text}"` : p ? "headline not shown: none given, or it does not match the hash on chain" : "",
    foot: p
      ? `signed by ${p.signer} · tx ${short(tx, 10)}${c.text ? " · sha256 matches the chain" : ""}${p.landed ? "" : " · REFUSED on chain"}`
      : `tx ${short(tx, 10)}`,
  };
  const font = await mono(Object.values(lines).join("") + verdict.t);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        color: C.fg,
        padding: "48px 56px",
        fontFamily: font ? "Mono" : "sans-serif",
        border: `2px solid ${C.dim}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: C.dim }}>
        <span style={{ color: C.warn }}>{lines.top}</span>
        <span>{p ? `${new Date(p.at_ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}</span>
      </div>
      <div style={{ display: "flex", fontSize: 30, color: C.hi, marginTop: 28 }}>{lines.target}</div>
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          fontSize: c.text && c.text.length > 140 ? 38 : 50,
          lineHeight: 1.25,
          color: c.text ? C.warn : C.dim,
        }}
      >
        {lines.text}
      </div>
      <div style={{ display: "flex", fontSize: 40, color: verdict.c }}>{verdict.t}</div>
      <div style={{ display: "flex", fontSize: 22, color: C.dim, marginTop: 20 }}>{lines.foot}</div>
    </div>,
    {
      width: 1200,
      height: 630,
      ...(font ? { fonts: [{ name: "Mono", data: font, weight: 500 as const, style: "normal" as const }] } : {}),
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
