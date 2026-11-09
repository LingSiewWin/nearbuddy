import json
import re
from collections import Counter

import corpus

KEYS = {"id", "template_id", "vector", "category", "asset", "direction", "text_cue", "text_clean", "source_paper_ref"}


def test_file_on_disk_is_the_generator_output():
    assert corpus.OUT.read_text() == corpus.dump(), "run `uv run --locked python corpus.py`"


def test_schema_and_unique_ids():
    rows = [json.loads(line) for line in corpus.OUT.read_text().splitlines()]
    assert all(r.keys() >= KEYS for r in rows)
    assert len({r["id"] for r in rows}) == len(rows)
    assert {r["direction"] for r in rows} == {"Long", "Short", None}
    assert all((r["direction"] is None) == (r["vector"] == "placebo") for r in rows)
    assert all("{" not in r["text_cue"] and "{" not in r["text_clean"] for r in rows)
    assert all(r["source_paper_ref"].startswith("arXiv:2610.26438") for r in rows)


def test_paper_counts_and_both_directions_per_asset():
    attack = [r for r in corpus.rows() if r["direction"]]
    templates = {r["template_id"] for r in attack}
    assert len(templates) == 62  # 25 vector-grounded + 37 event-grounded, as in section 4
    assert Counter(t.split("-")[0][:2] for t in templates if t.startswith("V")) == {f"V{i}": 5 for i in range(1, 6)}
    cats = Counter(next(r["category"] for r in attack if r["template_id"] == t) for t in templates if t.startswith("E"))
    assert cats == {"CA": 7, "GI": 6, "RG": 8, "EA": 7, "MS": 4, "MA": 3, "NA": 2}  # Table 2
    cells = Counter((r["template_id"], r["asset"], r["direction"]) for r in attack)
    assert set(cells.values()) == {1} and len(cells) == 62 * 4 * 2


def test_cue_and_clean_differ_only_in_tag_and_source():
    for r in corpus.rows():
        tag, source = r["cues"]
        clean = r["text_clean"]
        assert r["text_cue"] in (f"{tag} ({source}) - {clean}", f"{tag}: {clean} ({source})"), r["id"]
        # the clean text carries no cue of its own, so the clean arm is really cue-free
        for word in corpus.CUE_WORDS:
            assert not re.search(rf"\b{re.escape(word)}\b", clean, re.IGNORECASE), (r["id"], word)


def test_bull_and_bear_forms_differ():
    for tid, _, _, _, bull, bear in corpus.TEMPLATES:
        assert bull != bear, tid
