"""Detector (a): hand-written rule features. Deterministic, no model calls. A logistic regression in eval.py weighs
them; the lexicons are generic newswire vocabulary, not copied from the attack templates."""

from __future__ import annotations

import re

import numpy as np

URGENCY_TAG = re.compile(
    r"^\W*(breaking|just in|urgent|alert|flash|exclusive|developing|live|update|trending)\b"
    r"|(?-i:\b(BREAKING|JUST IN|URGENT)\b)",
    re.I,
)
URGENCY = re.compile(
    r"\b(overnight|this morning|tonight|imminent|within hours|right now|at midnight|before (the )?(us )?markets? open"
    r"|by (monday|tuesday|wednesday|thursday|friday)|tomorrow|this week|next week|immediately)\b",
    re.I,
)
OUTLET = re.compile(
    r"\b(reuters|bloomberg|wall street journal|wsj|financial times|cnbc|coindesk|the block|politico|fox business"
    r"|dl news|cointelegraph|decrypt|associated press|ap|axios|barron's|marketwatch|yahoo finance)\b",
    re.I,
)
ATTRIBUTION = re.compile(
    r"\b(according to|reports?|reported|told|said|says|confirm(s|ed)?|sources?|people familiar|filings?|statement"
    r"|memo|note seen|data shows?|citing|announced|per a|spokesperson|officials?|investigators|analysts?)\b",
    re.I,
)
BIG_PCT = re.compile(r"(?<![\d.])([2-9]\d|\d{3,})(\.\d+)?\s?%")
MONEY = re.compile(r"\$\s?\d[\d,.]*\s?(b|bn|billion|m|mn|million|k|thousand)?\b", re.I)
MULTIPLE = re.compile(r"\b\d+(\.\d+)?x\b|\b\d+\s?bps?\b|\b(doubled|tripled|record|all-time high)\b", re.I)
POSITIVE = re.compile(
    r"\b(approv\w*|surg\w*|soar\w*|rall\w*|bullish|upgrad\w*|beat\w*|record|gains?|jump\w*|buy\w*|accumulat\w*"
    r"|breakout|squeeze|undervalued|attractive|acquir\w*|partnership|win\w*|cut rates?|rate cut)\b",
    re.I,
)
NEGATIVE = re.compile(
    r"\b(arrest\w*|fraud|sue[sd]?|lawsuit|probe|investigat\w*|halt\w*|suspend\w*|freez\w*|frozen|exploit\w*|hack\w*"
    r"|breach\w*|bearish|downgrad\w*|miss\w*|collaps\w*|crash\w*|plung\w*|dump\w*|sell\w*|liquidat\w*|resign\w*"
    r"|sanction\w*|ban\w*|default\w*|insolven\w*|bankrupt\w*|negative|hostile|incompetent|failure)\b",
    re.I,
)

NAMES = [
    "urgency_tag",
    "urgency_words",
    "named_outlet",
    "attribution",
    "big_percent",
    "money",
    "multiple_or_record",
    "positive",
    "negative",
    "polarity",
    "caps_words",
    "exclamation",
]


def features(text: str) -> list[float]:
    words = text.split()
    pos, neg = len(POSITIVE.findall(text)), len(NEGATIVE.findall(text))
    return [
        float(bool(URGENCY_TAG.search(text))),
        float(len(URGENCY.findall(text))),
        float(len(OUTLET.findall(text))),
        float(len(ATTRIBUTION.findall(text))),
        float(len(BIG_PCT.findall(text))),
        float(len(MONEY.findall(text))),
        float(len(MULTIPLE.findall(text))),
        float(pos),
        float(neg),
        float(abs(pos - neg)),
        float(sum(w.isupper() and len(w) > 4 and w.isalpha() for w in words)),
        float(text.count("!")),
    ]


def matrix(texts: list[str]) -> np.ndarray:
    return np.array([features(t) for t in texts], dtype=np.float64)
