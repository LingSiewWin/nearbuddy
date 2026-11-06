// One share card from a plain object: the arena card today, duel and agent cards later. The look follows
// globals.css: warm near-black ground, wide Archivo for the headline, colour for *who* (one per model
// family) and the red hatch only for a paid lie that worked. Fonts are static Archivo instances from Google
// Fonts (SIL Open Font License 1.1; copyright and licence ship in each file's name table), bundled so a
// card never waits on a font CDN.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { tone } from "../ui/format";

type Fonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;

export const OG = { width: 1200, height: 630 };

const C = {
  bg: "#17160F",
  line: "#323026",
  ink: "#EEE9D8",
  dim: "#A39D89",
  qwen: "#F2A93B",
  deep: "#6EC5E9",
  other: "#B9D38A",
  alarm: "#FF4B4B",
};
export type Tone = keyof typeof C;
/** A run of text; a bare string is ink. */
export type Span = string | { t: string; tone: Tone };
/** One paid lie as the arena's squares show it. */
export type Mark = "resisted" | "named" | "fell" | "unmoved";
export type Card = {
  /** The headline, one line per sentence where the width allows. */
  title: Span[][];
  /** One dim line under the headline that says what it means. */
  sub?: Span[];
  /** Squares rows under the headline, e.g. a model's record against paid lies. */
  rows?: { label: Span[]; marks: Mark[] }[];
  /** Bottom left, e.g. the live duel. */
  foot?: Span[];
  /** Bottom right, small, e.g. "343 duels on NEAR testnet". */
  note?: string;
};

/** The identity colour of a model family, as the pages use it. */
export const toneOf = (model: string | null | undefined): Tone =>
  (({ "k-qwen": "qwen", "k-deep": "deep", "k-other": "other" }) as const)[tone(model)];

const file = (name: string) => readFile(join(process.cwd(), "app/og", name));
// read on the first card, not at import, so the pure helpers here load anywhere
let assets: Promise<[Fonts, string]> | null = null;
const load = async (): Promise<[Fonts, string]> => {
  const [wide800, wide300, text500, text700, mark] = await Promise.all([
    file("archivo-expanded-800.ttf"),
    file("archivo-expanded-300.ttf"),
    file("archivo-500.ttf"),
    file("archivo-700.ttf"),
    readFile(join(process.cwd(), "app/icon.svg"), "base64"),
  ]);
  const fonts: Fonts = [
    { name: "Wide", data: wide800, weight: 800, style: "normal" },
    { name: "Wide", data: wide300, weight: 300, style: "normal" },
    { name: "Archivo", data: text500, weight: 500, style: "normal" },
    { name: "Archivo", data: text700, weight: 700, style: "normal" },
  ];
  return [fonts, mark];
};

const HATCH = `repeating-linear-gradient(135deg, ${C.alarm} 0px, ${C.alarm} 4px, transparent 4px, transparent 8px)`;

/** Words as flex items so mixed-colour runs wrap like one sentence; named runs are bold. */
function Words({ spans, bold = 700 }: { spans: Span[]; bold?: number }) {
  const words = spans.flatMap((s, i) => {
    const { t, tone: k } = typeof s === "string" ? { t: s, tone: undefined } : s;
    return t
      .split(" ")
      .filter(Boolean)
      .map((w, j) => ({ w, k, key: `${i}.${j}` }));
  });
  return (
    // spaces as right margins, not columnGap: the renderer leaves the gap out when it sizes the box
    <div style={{ display: "flex", flexWrap: "wrap" }}>
      {words.map(({ w, k, key }, i) => (
        <span
          key={key}
          style={{ marginRight: i < words.length - 1 ? "0.26em" : 0, ...(k ? { color: C[k], fontWeight: bold } : {}) }}
        >
          {w}
        </span>
      ))}
    </div>
  );
}

function Square({ m }: { m: Mark }) {
  const s = { width: 28, height: 28, border: `2px solid ${C.ink}` };
  if (m === "fell") return <div style={{ ...s, borderColor: C.alarm, backgroundImage: HATCH }} />;
  // named it but took its side: ink over the hatch, as on the page
  if (m === "named")
    return (
      <div
        style={{
          ...s,
          borderColor: C.alarm,
          backgroundImage: `linear-gradient(135deg, ${C.ink} 0 50%, transparent 50%), ${HATCH}`,
        }}
      />
    );
  return <div style={{ ...s, background: m === "resisted" ? C.ink : "transparent" }} />;
}

const PAD = 64;
const textOf = (spans: Span[]) => spans.map((s) => (typeof s === "string" ? s : s.t)).join(" ");

export async function drawCard(card: Card, size = OG) {
  assets ??= load();
  const [fonts, mark] = await assets;
  // wide Archivo 800 runs about 0.58 em per character: size the headline so its longest sentence fits one
  // line; a longer one still wraps
  const longest = Math.max(...card.title.map((p) => textOf(p).length), 1);
  const fontSize = Math.max(44, Math.min(96, Math.floor((size.width - 2 * PAD) / (longest * 0.58))));
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        color: C.ink,
        fontFamily: "Archivo",
        fontWeight: 500,
        padding: `48px ${PAD}px 0`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <img src={`data:image/svg+xml;base64,${mark}`} width={44} height={44} alt="" />
        <div style={{ display: "flex", fontFamily: "Wide", fontSize: 30, letterSpacing: -0.3 }}>
          <span style={{ fontWeight: 800 }}>NearBuddy</span>
          <span style={{ fontWeight: 300, color: C.dim, marginLeft: 10 }}>arena</span>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 24, color: C.dim }}>
          Every call signed in an enclave, checked on chain
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          fontFamily: "Wide",
          fontWeight: 800,
          fontSize,
          lineHeight: 1.02,
          letterSpacing: -fontSize * 0.025,
        }}
      >
        {card.title.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
          <Words key={i} spans={p} bold={800} />
        ))}
      </div>
      {card.sub ? (
        <div style={{ display: "flex", marginTop: 18, fontSize: 28, color: C.dim }}>
          <Words spans={card.sub} />
        </div>
      ) : null}

      {card.rows?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 36 }}>
          {card.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 24 }}>
              <Words spans={r.label} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {r.marks.map((m, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: squares are positional
                  <Square key={j} m={m} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: 40,
          height: 88,
          borderTop: `2px solid ${C.line}`,
          fontSize: 26,
          color: C.dim,
        }}
      >
        {card.foot ? <Words spans={card.foot} /> : null}
        {card.note ? <div style={{ marginLeft: "auto", paddingLeft: 24 }}>{card.note}</div> : null}
      </div>
    </div>,
    { ...size, fonts },
  );
}
