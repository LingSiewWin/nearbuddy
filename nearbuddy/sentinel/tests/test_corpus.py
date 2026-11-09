import json

import corpus
import pytest


def test_provisional_rows_differ_only_in_cues():
    rows = corpus.provisional_rows()
    assert len({r["id"] for r in rows}) == len(rows)
    assert {r["vector"] for r in rows} == {"V1", "V2", "V3", "V4", "V5", "placebo"}
    assert {r["category"] for r in rows} == {"CA", "GI", "RG", "EA", "MS", "MA", "NA", "placebo"}
    for r in rows:
        assert set(r) == set(corpus.FIELDS)
        assert "[[" not in r["text_cue"] and "{" not in r["text_cue"]
        assert r["text_cue"] != r["text_clean"]
        # the clean text is the cue text with spans removed: its characters appear in order in the cue text
        cue_chars = iter(r["text_cue"].replace(" ", ""))
        assert all(ch in cue_chars for ch in r["text_clean"].replace(" ", "")), r["id"]
        assert (r["direction"] is None) == (r["vector"] == "placebo")


def test_load_corpus_round_trips_and_rejects_a_missing_field(tmp_path):
    path = corpus.write_provisional(tmp_path / "a.jsonl")
    assert corpus.load_corpus(path) == corpus.provisional_rows()
    row = corpus.provisional_rows()[0]
    del row["text_clean"]
    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="text_clean"):
        corpus.load_corpus(bad)


def test_clean_text_drops_links_and_collapses_whitespace():
    assert corpus.clean_text("  a\tb\n https://x.y/z c ") == "a b c"
