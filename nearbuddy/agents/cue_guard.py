"""Strip credibility cues from a paid headline before a model reads it.

`normalize(text)` returns (clean text, cues removed). arXiv 2610.26438 found that the surface form of a fake headline,
not its claim, makes a trading agent act on it: removing a "BREAKING" tag or a named source took a template from 100%
to 0% attack success while the claim stayed the same. This module removes those cues and keeps the claim:

- urgency tags: BREAKING, JUST IN, URGENT, ALERT, EXCLUSIVE, DEVELOPING, a leading "NEWS:", siren and other emoji;
- source and authority attributions: named outlets and agencies, "according to ...", "per ...", "... reports",
  "sources say", "confirmed by ...";
- emphasis: ALL-CAPS shouting, "!!!", markdown bold, italics and headers.

Numbers, tickers and asset names are never changed. Hedges ("unconfirmed", "reportedly", "rumor") are kept: they lower
a claim's credibility, and removing them would raise it.

Evasions it undoes first (`fold`): NFKC (fullwidth, mathematical bold, circled letters), Greek and Cyrillic look-alikes
and small capitals inside a Latin word, zero-width and other invisible characters, combining overlays, and spaced
letters ("B R E A K I N G", "B.R.E.A.K.I.N.G") that spell a cue word.

Deterministic and model-free: the same input gives the same output on any machine, so the clean arm of an experiment
can be recomputed from the signed request bytes, and a TS or Rust port is checked against
fixtures/cue-guard-vectors.json.

ponytail: word lists, not a model. A cue phrased outside the lists ("hot off the wire") passes, and a ticker of four or
more letters missing from KEEP is lowercased when shouted; extend the lists and add a vector when the corpus finds one.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable

import cue_guard_v1

# Recorded on every guarded dataset row (`guard.cue_guard`), so the row is re-checked with the cue_guard that cleaned
# its headline. Any change to what `normalize` returns is a new version: copy this file to cue_guard_v<N>.py unchanged,
# add it to VERSIONS and bump this number.
CUE_GUARD_VERSION = 1

# Letters that render like Latin ones: Greek, Cyrillic, and small capitals (mapped to capitals, which they look like).
# Applied only to a word whose every non-ASCII letter is in this table, so a genuine Greek or Russian word is kept.
CONFUSABLES = {
    **dict(zip("ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", "ABEZHIKMNOPTYX", strict=True)),
    **dict(zip("αικνορυχ", "aiknopux", strict=True)),
    **dict(zip("АВЕКМНОРСТУХЅІЈԌ", "ABEKMHOPCTYXSIJG", strict=True)),
    **dict(zip("аеорсухѕіјһԁԛԝ", "aeopcyxsijhdqw", strict=True)),
    **dict(zip("ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ", "ABCDEFGHIJKLMNOPRSTUVWYZ", strict=True)),
    "ı": "i",
}
_CONFUSABLE_TABLE = str.maketrans(CONFUSABLES)
# combining marks NFKC leaves behind (overlays, zalgo, keycaps, variation selectors); precomposed letters such as é
# are single code points after NFKC and are kept
_MARKS = re.compile("[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f]")
_WORD = re.compile(r"\w+")

# urgency tags. STRONG ones are removed in capitals anywhere; WEAK ones only as a tag (bracketed, or at the start of a
# line or sentence followed by ":", "-", "|").
STRONG = (
    "breaking news",
    "breaking",
    "this just in",
    "just in",
    "newsflash",
    "news flash",
    "flash",
    "urgent",
    "red alert",
    "market alert",
    "price alert",
    "alert",
    "exclusive",
    "developing story",
    "developing",
    "top story",
    "must read",
)
WEAK = (
    "news",
    "new",
    "update",
    "updated",
    "live",
    "hot",
    "confirmed",
    "official",
    "warning",
    "important",
    "attention",
    "heads up",
    "report",
    "reports",
    "scoop",
)

# named outlets, wires, on-chain trackers, agencies and authorities
SOURCES = (
    "Reuters",
    "Bloomberg News",
    "Bloomberg Terminal",
    "Bloomberg Intelligence",
    "Bloomberg",
    "Associated Press",
    "AP",
    "AFP",
    "CNBC",
    "CNN",
    "BBC",
    "Fox Business",
    "Fox News",
    "Wall Street Journal",
    "WSJ",
    "Financial Times",
    "FT",
    "New York Times",
    "NYT",
    "Washington Post",
    "Barron's",
    "MarketWatch",
    "Forbes",
    "Fortune",
    "Business Insider",
    "Yahoo Finance",
    "Dow Jones",
    "Nikkei",
    "Axios",
    "Politico",
    "The Information",
    "CoinDesk",
    "The Block",
    "Cointelegraph",
    "Decrypt",
    "Blockworks",
    "DL News",
    "Bitcoin Magazine",
    "Watcher Guru",
    "Watcher.Guru",
    "WatcherGuru",
    "Whale Alert",
    "Lookonchain",
    "Arkham Intelligence",
    "Arkham",
    "Nansen",
    "Glassnode",
    "Santiment",
    "Kaiko",
    "Wu Blockchain",
    "Unusual Whales",
    "Zero Hedge",
    "Zerohedge",
    "Walter Bloomberg",
    "Tree News",
    "Xinhua",
    "TASS",
    "Al Jazeera",
    "The Guardian",
    "Caixin",
    "SCMP",
    "South China Morning Post",
    "U.S. SEC",
    "US SEC",
    "SEC",
    "Securities and Exchange Commission",
    "CFTC",
    "Federal Reserve",
    "Fed",
    "FOMC",
    "U.S. Treasury",
    "US Treasury",
    "Treasury Department",
    "Treasury",
    "DOJ",
    "Department of Justice",
    "Justice Department",
    "FBI",
    "IRS",
    "OFAC",
    "FinCEN",
    "FCA",
    "ESMA",
    "ECB",
    "IMF",
    "MAS",
    "SFC",
    "PBOC",
    "People's Bank of China",
    "Bank of Japan",
    "BOJ",
    "Bank of England",
    "BoE",
    "White House",
    "FDA",
    "NEAR Foundation",
)

# unnamed authorities: "sources", "two people familiar with the matter", "a senior official", "wires"
GENERIC = (
    r"\b(?:(?:multiple|several|two|three|four|many|anonymous|unnamed|senior|top|government|federal|exchange|industry"
    r"|market|trusted|reliable|credible|insider)[ \t]+)*"
    r"(?:sources?|insiders?|officials?|people|persons?|investigators?|prosecutors?|regulators?|analysts?|traders?"
    r"|wires?|reporters?|journalists?|whistleblowers?|executives?|bankers?|an?[ \t]+(?:senior[ \t]+)?"
    r"(?:source|person|official|insider))"
    r"(?:[ \t]+(?:familiar|close)[ \t]+(?:with|to)[ \t]+(?:the[ \t]+)?(?:matter|situation|deal|talks|investigation"
    r"|plans?|negotiations|company|exchange|decision))?"
)

# ALL-CAPS words kept as written: tickers, asset names, currencies, agencies and finance acronyms. Any other capitals
# word of 4+ letters is shouting, and so is a 2-3 letter one in SHORT_WORDS; other 2-3 letter words are kept.
KEEP = frozenset(
    """BTC ETH NEAR SOL BNB XRP ADA DOGE SHIB PEPE AVAX DOT LINK MATIC POL ATOM LTC BCH TRX TON SUI APT ARB OP INJ TIA
    SEI STX IMX FIL ICP HBAR ETC XLM XMR ALGO VET EGLD AAVE UNI MKR LDO CRV COMP SNX GRT RNDR RENDER FET AGIX OCEAN WLD
    JUP PYTH BONK WIF FLOKI ENA ONDO TAO KAS MNT BEAM AXS SAND MANA GALA FLOW CHZ KAVA ROSE CAKE LUNA FTM CELO ZEC DASH
    EOS NEO QNT HYPE USDT USDC DAI FDUSD PYUSD TUSD BUSD USDE WBTC WETH STETH AURORA ZCASH BITCOIN ETHEREUM SOLANA
    CARDANO RIPPLE DOGECOIN POLKADOT CHAINLINK AVALANCHE POLYGON COSMOS LITECOIN TRON TONCOIN TETHER APTOS ARBITRUM
    OPTIMISM CELESTIA MONERO STELLAR HEDERA FILECOIN USD EUR JPY GBP CNY CHF CAD AUD HKD SGD KRW INR CPI PPI GDP PCE NFP
    FOMC FED ECB BOJ BOE SEC CFTC DOJ FBI IRS OFAC FINCEN FCA ESMA IMF OPEC NATO NASA NYSE NASDAQ CME CBOE ETF IPO CEO
    CFO CTO COO API DAO DEX CEX NFT DEFI TVL ATH ATL OTC KYC AML USA UAE SPX SPY QQQ NDX DXY VIX AAPL TSLA NVDA MSFT
    AMZN GOOG GOOGL META COIN MSTR HOOD JPM FTX OKX HTX MEXC""".split()  # noqa: SIM905
)
SHORT_WORDS = frozenset(
    """AN AS AT BE BY DO GO HE IF IN IS IT ME MY NO OF OH ON OR SO TO UP WE ALL AND ANY ARE BAD BIG BUY CAN CUT DID
    FOR GET GOT HAS HAD HER HIM HIS HIT HOW ITS LOW MAY NEW NOT NOW OFF OLD ONE OUR OUT OWN PUT RUN SAY SEE SET SHE
    THE TOO TOP TWO WAR WAS WAY WHO WHY WIN YES YET YOU GOD OMG WOW LOL""".split()  # noqa: SIM905
)

_GAP = r"[ \t]+"


def _alt(words: tuple[str, ...]) -> str:
    """Regex alternation of phrases, longest first, with any run of blanks between their words."""
    return "|".join(_GAP.join(map(re.escape, w.split())) for w in sorted(words, key=len, reverse=True))


_TAG = _alt(STRONG + WEAK)
_SRC = rf"(?:the{_GAP})?(?<![\w@])(?:{_alt(SOURCES)})(?![\w])"
_WHO = rf"(?:{_SRC}|(?:the{_GAP})?{GENERIC}\b)"
_VERB = (
    r"(?:reports?|reported|reporting|says?|said|saying|confirms?|confirmed|tells|told|writes|wrote|has[ \t]+learned"
    r"|learned|understands|notes?|noted)\b"
)
# start of a line or of a sentence or clause, where a tag or an attribution can lead
_START = r"(?:^|(?<=[.!?;:|\n\u2013\u2014]))[ \t]*"
# a short attribution object: 1-8 words with no digit, up to the end of the clause
_NAME = r"(?:@\w+|[^\W\d_](?:[^\W\d]|['’.&-](?=[^\W\d_]))*)"  # a word with no digit; "U.S", not "matter."
_OBJECT = rf"{_NAME}(?:[ \t]+{_NAME}){{0,7}}"
_CLAUSE_END = r"(?=[ \t]*(?:[,.;:!?\n]|$))"
_SPACED = re.compile(r"(?<![A-Za-z])(?:[A-Za-z][ .\-_*·•|]{1,3}){3,}[A-Za-z](?![A-Za-z])")  # 4+ letters
# a spaced-out cue word or source name, by its letters: "breakingnews" -> "breaking news"
_SPACED_PHRASES = {re.sub(r"[^a-z]", "", w.lower()): w for w in STRONG + WEAK + SOURCES}
_SPACED_ONE = re.compile("|".join(sorted(_SPACED_PHRASES, key=len, reverse=True)), re.I)
_EMOJI = "[\U0001f000-\U0001faff\u2300-\u23ff\u2600-\u27bf\u2b00-\u2bff\u3030\u303d\u3297\u3299][\ufe0e\ufe0f]?"
# a run of emoji (siren, fire, rocket, warning sign, ...), with the blanks and joiners between them
_EMOJI_RUN = re.compile(rf"{_EMOJI}(?:[ \t\u200b-\u200f]*{_EMOJI})*")

# (pattern, replacement) in order; every match is a cue. A removal leaves a blank that `_tidy` folds away.
_EMPHASIS = [
    (re.compile(r"(?<!\w)\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\w)"), r"\1"),
    (re.compile(r"(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)"), r"\1"),
    (re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])"), r"\1"),
    (re.compile(r"(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])"), r"\1"),
    (re.compile(r"(?<!\w)~~(?=\S)(.+?)(?<=\S)~~(?!\w)"), r"\1"),
    (re.compile(r"^[ \t]*#{1,6}[ \t]+", re.M), ""),
]
_CUTS = [
    # attributions; a trailing "Source: X" before the leading "Sources:" can take it
    re.compile(rf"(?<=\S)[ \t]+(?:sources?|credit)[ \t]*:[ \t]*(?:{_SRC}|{_OBJECT})[ \t]*$", re.I | re.M),
    re.compile(rf"{_START}(?:{_SRC}|@\w+|{GENERIC})[ \t]*(?::|\||[ \t][-\u2013\u2014](?!\d))", re.I | re.M),
    re.compile(rf"[ \t]*[\[(](?:{_SRC}|@\w+|via[ \t]+[^)\]\n]+)[\])](?:[ \t]*[-\u2013\u2014](?!\d))?", re.I),
    re.compile(rf"{_START}{_WHO}[ \t]+{_VERB}(?:[ \t]+that)?[ \t]*[,:]?", re.I | re.M),
    re.compile(rf",[ \t]*{_WHO}[ \t]+{_VERB}[ \t]*,", re.I),
    re.compile(
        rf"[,;]?[ \t]*{_WHO}[ \t]+{_VERB}(?:[ \t]+(?:in|on|via)[ \t]+(?:a|an|the|its|their)[ \t]+[^\W\d_]+"
        rf"(?:[ \t]+[^\W\d_]+)?)?(?=[ \t]*(?:[.;!?\n]|$))",
        re.I,
    ),
    re.compile(rf"[,;]?[ \t]*\baccording[ \t]+to[ \t]+(?:{_SRC}|{_OBJECT}{_CLAUSE_END})", re.I),
    re.compile(
        rf"[,;]?[ \t]*\b(?:per|citing)[ \t]+(?:(?:{_NAME}[ \t]+){{1,4}}?(?:by|from)[ \t]+{_SRC}|an?[ \t]+report"
        rf"|reports|{_SRC}|(?:the[ \t]+)?{GENERIC}\b|@\w+)",
        re.I,
    ),
    re.compile(
        rf"[,;]?[ \t]*\b(?:as[ \t]+)?(?:(?:officially|first|exclusively)[ \t]+)?(?:confirmed|reported|verified|cited"
        rf"|announced)[ \t]+by[ \t]+{_OBJECT}{_CLAUSE_END}",
        re.I,
    ),
    re.compile(rf"[ \t]*(?:[-\u2013\u2014|][ \t]*(?:{_SRC}|@\w+)|\b(?:via|h/t)[ \t]+@\w+)[ \t]*$", re.I | re.M),
    re.compile(rf"\b(?:via|h/t)[ \t]+(?:{_SRC}|@\w+)", re.I),
    # urgency tags
    re.compile(rf"[ \t]*[\[(【{{<][ \t]*(?:{_TAG})[ \t]*[\])】}}>](?:[ \t]*(?:[:|\u2013\u2014]|-(?!\d))+)?", re.I),
    re.compile(rf"{_START}(?:{_TAG})[ \t]*(?:[:|\u2013\u2014]|-(?!\d))+", re.I | re.M),
    re.compile(rf"{_START}(?:{_alt(tuple(w.upper() for w in STRONG))}|(?i:breaking{_GAP}news))(?=[ \t])", re.M),
    re.compile(
        r"(?<![\w$])(?:BREAKING[ \t]+NEWS|BREAKING(?![ \t]+(?:OUT|DOWN|UP|ABOVE|BELOW|THROUGH|PAST|UNDER|OVER|INTO"
        r"|RESISTANCE|SUPPORT|HIGHS?|LOWS?|RECORDS?|NEW|\$|\d))|THIS[ \t]+JUST[ \t]+IN|JUST[ \t]+IN(?![ \t]+(?:CASE"
        r"|TIME))|URGENT|ALERT|NEWSFLASH|EXCLUSIVE|DEVELOPING[ \t]+STORY)(?!\w)"
    ),
]
_SHOUT = re.compile(r"(?<![\w$#/])[A-Z][A-Z'’]*[A-Z](?![\w/])")
_EXCLAIM = re.compile(r"[ \t]*[!?](?:[ \t]*[!?])+")
_SEPS = " \t\n,;:|-\u2013\u2014"


def _fold_word(m: re.Match[str]) -> str:
    w = m.group()
    if all(ch.isascii() or ch in CONFUSABLES for ch in w if ch.isalpha()):
        return w.translate(_CONFUSABLE_TABLE)
    return w


def _join_spaced(m: re.Match[str]) -> str:
    """'B R E A K I N G  N E W S' -> 'BREAKING NEWS' (the letters as written, the phrase's own blanks); a run that is
    not made of cue words and source names is left as it is."""
    letters = re.sub(r"[^A-Za-z]", "", m.group())
    parts = _SPACED_ONE.findall(letters)
    if "".join(parts) != letters:
        return m.group()
    words = []
    for part in parts:
        letters = iter(part)
        phrase = _SPACED_PHRASES[part.lower()]
        words.append("".join(next(letters) if ch.isalpha() else ch for ch in phrase if ch.isalpha() or ch == " "))
    return " ".join(words)


def fold(text: str) -> str:
    """Undo the evasions: NFKC, invisible characters and leftover combining marks removed, emoji blanked, look-alike
    letters mapped to Latin inside Latin-looking words, and spaced letters joined when they spell a cue word or a
    source name."""
    s = unicodedata.normalize("NFKC", text)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Cf")
    s = _MARKS.sub("", s)
    s = _EMOJI_RUN.sub(" ", s)  # normalize cuts them first, as cues; here they are blanks between words
    s = _WORD.sub(_fold_word, s)
    return _SPACED.sub(_join_spaced, s)


def _cut(pattern: re.Pattern[str], repl: str, s: str, cues: list[str]) -> str:
    def one(m: re.Match[str]) -> str:
        # emphasis keeps its text (group 1) and reports only the opening marker
        cue = (m.group()[: m.start(1) - m.start()] if m.re.groups else m.group()).strip(_SEPS)
        if cue:
            cues.append(cue)
        return m.expand(repl) if repl else " "

    return pattern.sub(one, s)


def _exclaim(s: str, cues: list[str]) -> str:
    """'!!!', '!?!' and '! ! !' are emphasis: '?' when the run asks, else a full stop before more text."""

    def one(m: re.Match[str]) -> str:
        run = m.group()
        if "!" not in run:
            return run
        cues.append(run.strip())
        if "?" in run:
            return "?"
        return "." if s[m.end() :].strip() else ""

    return _EXCLAIM.sub(one, s)


def _unshout(s: str, cues: list[str]) -> str:
    """Lowercase capitals words that are not tickers, asset names or acronyms; capitalise one that starts a line or a
    sentence."""

    def one(m: re.Match[str]) -> str:
        w = m.group()
        if w in KEEP or (len(w) <= 3 and w not in SHORT_WORDS):
            return w
        cues.append(w)
        low = w.lower()
        at_start = re.search(r"(?:^|[.!?\n])[ \t\"'“(]*$", s[: m.start()]) is not None
        return low[0].upper() + low[1:] if at_start else low

    return _SHOUT.sub(one, s)


def _tidy(s: str) -> str:
    lines = []
    for line in s.split("\n"):
        line = re.sub(r"\([ \t]*\)|\[[ \t]*\]|\"[ \t]*\"|“[ \t]*”", " ", line)  # a blank: "J( )h" is two words
        line = re.sub(r"[ \t]+", " ", line)
        line = re.sub(r" +([,.;:!?])(?!\d)", r"\1", line)
        line = re.sub(r"([,;:])(?: *[,;:])+", r"\1", line)
        line = re.sub(r"[,;:] *([.!?])", r"\1", line)
        line = re.sub(r"^(?:[ ,;:|/!?*_~>\u2013\u2014]|[-.](?!\d))+", "", line)
        line = re.sub(r"[ ,;:|/\u2013\u2014-]+$", "", line)
        line = line.strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def normalize(text: str) -> tuple[str, list[str]]:
    """(clean text, cues removed in the order they were found). Idempotent: `normalize(clean) == (clean, [])`.

    >>> normalize("🚨 BREAKING: Binance halts NEAR withdrawals, according to Reuters!!!")
    ('Binance halts NEAR withdrawals', ['🚨', 'according to Reuters', 'BREAKING', '!!!'])
    """
    cues: list[str] = []
    s = text
    for _ in range(32):  # each pass only removes or lowercases, so it reaches a fixed point in a few passes
        before = s
        s = fold(_cut(_EMOJI_RUN, "", s, cues))
        for pattern, repl in _EMPHASIS:
            s = _cut(pattern, repl, s, cues)
        for pattern in _CUTS:
            s = _cut(pattern, "", s, cues)
        s = _exclaim(s, cues)
        s = _unshout(s, cues)
        s = _tidy(s)
        if s == before:
            break
    return s, cues


# `normalize` of every published version; rows without `guard.cue_guard` were cleaned by version 1
VERSIONS: dict[int, Callable[[str], tuple[str, list[str]]]] = {1: cue_guard_v1.normalize, CUE_GUARD_VERSION: normalize}
