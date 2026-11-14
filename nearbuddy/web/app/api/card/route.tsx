// GET /api/card?tx=<inject_chaos tx>: the 1200x630 share image for one planted headline, always dark. It is built
// from the same record as the result page (api/planted.ts), so the two never disagree: the verdict word, the
// headline, the two-segment Trace and the sentence. No payout, no slogan, no rank. A card exists only for a headline
// the chain holds for a landed attack (lib/card.ts shownText) that is not on the team's hide list; anything else
// answers 404 and the page shows no share button.
import { ImageResponse } from "next/og";
import { TX_RE } from "../../lib/card";
import { geometry, recordTrace } from "../../ui/trace";
import { cardFlip, sentence, VERDICT } from "../../ui/verdict";
import { card } from "../planted";

const C = {
  bg: "#0f1113",
  fg: "#e9e6df",
  hi: "#ffffff",
  dim: "#9a9fa5",
  rule: "#2b3035",
  signal: "#ff6b4a",
  proof: "#6fa8f5",
  caution: "#e0b040",
};
const TONE = { signal: C.signal, ink: C.fg, caution: C.caution };

/** One Google Fonts face cut to the glyphs the card prints; null when the fetch fails. */
async function face(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(
        `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(3000) },
      )
    ).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
    return url ? await (await fetch(url, { signal: AbortSignal.timeout(3000) })).arrayBuffer() : null;
  } catch {
    return null;
  }
}

const TRACE = { width: 980, height: 96, padL: 0, padR: 0 };

export async function GET(req: Request) {
  const tx = new URL(req.url).searchParams.get("tx") ?? "";
  if (!TX_RE.test(tx)) return new Response("tx must be a transaction hash", { status: 400 });
  const c = await card(tx, null);
  const rec = c.record;
  if (!c.planted || !rec || !c.text || c.hidden)
    return new Response("no card for this transaction", { status: 404, headers: { "cache-control": "no-store" } });

  const waiting = rec.outcome === "Pending";
  const verdict = waiting
    ? { word: "WAITING", color: C.caution }
    : {
        word: VERDICT[rec.outcome as keyof typeof VERDICT].word,
        color: TONE[VERDICT[rec.outcome as keyof typeof VERDICT].tone],
      };
  const model = c.model ?? "The AI";
  const line = waiting ? `Waiting for ${model}'s next decision.` : (sentence(rec, "public", model) ?? "");
  const flip = cardFlip(rec.arm) ?? "";
  // the production domain as the platform configures it, else the host this request came to
  const site = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? new URL(req.url).host;
  const foot = `${c.tee ? "Signed inside a secure enclave · " : ""}verify: ${site}/i/${tx.slice(0, 8)}`;
  const date = c.planted.at_ms ? new Date(c.planted.at_ms).toISOString().slice(0, 10) : "";
  const duel = `Duel #${c.planted.duel_id}`;
  const quote = `“${c.text}”`;

  // IBM Plex Sans 600 and Newsreader 500 as on the site; a failed fetch falls back to the mono face the card used
  // before, and without that to the font bundled with the image response
  const sansText = `NearBuddy${verdict.word}${line}${flip}UPDN`;
  const monoText = `${duel}${foot}${date}`;
  const [sans, serif, mono] = await Promise.all([
    face("IBM+Plex+Sans", 600, sansText),
    face("Newsreader", 500, quote),
    face("Geist+Mono", 500, monoText + sansText + quote),
  ]);
  const fonts = [
    ...(sans ? [{ name: "Sans", data: sans, weight: 600 as const, style: "normal" as const }] : []),
    ...(serif ? [{ name: "Serif", data: serif, weight: 500 as const, style: "normal" as const }] : []),
    ...(mono ? [{ name: "Mono", data: mono, weight: 500 as const, style: "normal" as const }] : []),
  ];
  const fam = (want: string | null, name: string) => (want ? name : mono ? "Mono" : "sans-serif");
  const F = { sans: fam(sans && "y", "Sans"), serif: fam(serif && "y", "Serif"), mono: mono ? "Mono" : "monospace" };

  const g = geometry(recordTrace(rec), TRACE);
  const pin = g.pins[0];
  const zone = g.zones[0];
  const hatch = zone ? Array.from({ length: Math.floor((zone.x2 - zone.x1) / 8) }, (_, i) => zone.x1 + 4 + i * 8) : [];

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: C.bg,
        color: C.fg,
        padding: 24,
        fontFamily: F.sans,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          border: `1px solid ${C.rule}`,
          padding: "30px 40px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 28, color: C.hi }}>NearBuddy</span>
          <span style={{ fontSize: 22, color: C.dim, fontFamily: F.mono }}>{duel}</span>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 120,
            lineHeight: 1,
            letterSpacing: 2,
            color: verdict.color,
            marginTop: 14,
          }}
        >
          {verdict.word}
        </div>
        <div
          style={{
            display: "block",
            lineClamp: 3,
            fontFamily: F.serif,
            fontSize: c.text.length > 100 ? 36 : 44,
            lineHeight: 1.2,
            color: C.hi,
            marginTop: 14,
          }}
        >
          {quote}
        </div>
        <div style={{ display: "flex", alignItems: "center", marginTop: "auto" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              width: 60,
              height: 68,
              fontSize: 18,
              color: C.dim,
            }}
          >
            <span>UP</span>
            <span>DN</span>
          </div>
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: rasterised into the card image; the page carries the text */}
          <svg width={TRACE.width} height={TRACE.height} viewBox={`0 0 ${TRACE.width} ${TRACE.height}`}>
            <line x1={0} x2={TRACE.width} y1={g.railUp} y2={g.railUp} stroke={C.rule} strokeWidth={1} />
            <line x1={0} x2={TRACE.width} y1={g.railDown} y2={g.railDown} stroke={C.rule} strokeWidth={1} />
            {g.gap ? (
              <line
                x1={g.gap.x1}
                x2={g.gap.x2}
                y1={g.gap.y}
                y2={g.gap.y}
                stroke={C.rule}
                strokeWidth={3}
                strokeDasharray="3 6"
              />
            ) : null}
            {zone
              ? hatch.map((x) => (
                  <line
                    key={x}
                    x1={x - 6}
                    x2={x + 6}
                    y1={zone.y + zone.h}
                    y2={zone.y}
                    stroke={C.caution}
                    strokeOpacity={0.5}
                    strokeWidth={1.5}
                  />
                ))
              : null}
            {g.ink ? <polyline points={g.ink} fill="none" stroke={C.fg} strokeWidth={4} /> : null}
            {g.red ? <polyline points={g.red} fill="none" stroke={C.signal} strokeWidth={5} /> : null}
            {pin ? (
              pin.mark === "fooled" ? (
                <path
                  d={`M${pin.x} ${pin.y - 11}L${pin.x + 11} ${pin.y}L${pin.x} ${pin.y + 11}L${pin.x - 11} ${pin.y}Z`}
                  fill={C.signal}
                />
              ) : pin.mark === "held" ? (
                <circle cx={pin.x} cy={pin.y} r={9} fill={C.bg} stroke={C.fg} strokeWidth={3} />
              ) : pin.mark === "waiting" ? (
                <circle cx={pin.x} cy={pin.y} r={9} fill={C.caution} />
              ) : (
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={9}
                  fill={C.bg}
                  stroke={C.caution}
                  strokeWidth={2.5}
                  strokeDasharray="5 4"
                />
              )
            ) : null}
          </svg>
        </div>
        <div style={{ display: "flex", fontSize: 26, marginTop: 18 }}>{line}</div>
        <div style={{ display: "flex", fontSize: 22, color: C.dim, marginTop: 6, minHeight: 28 }}>{flip}</div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 20,
            color: C.proof,
            fontFamily: F.mono,
            marginTop: 16,
          }}
        >
          <span>{foot}</span>
          <span>{date}</span>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      ...(fonts.length ? { fonts } : {}),
      // a waiting card changes when the verdict lands, so it is never kept
      headers: { "cache-control": waiting ? "no-store" : "public, max-age=300" },
    },
  );
}
