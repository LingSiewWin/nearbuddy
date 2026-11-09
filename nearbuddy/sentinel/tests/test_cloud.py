import cloud
import numpy as np
import pytest


def test_parse_p_takes_the_last_answer():
    assert cloud.parse_p('format {"p": 0}... final {"p": 85}') == 0.85
    assert cloud.parse_p("no answer") is None


def test_spend_cap_and_cache(tmp_path):
    spend = cloud.Spend(tmp_path / "spend.jsonl", cap=0.001)
    assert spend.log(cloud.JUDGE_MODEL, 1000, 1000, "t") == pytest.approx((1000 * 0.08 + 1000 * 0.50) / 1e6)
    spend.check()
    spend.log(cloud.JUDGE_MODEL, 0, 2000, "t")
    with pytest.raises(RuntimeError, match="cap"):
        spend.check()
    cache = cloud.Cache(tmp_path / "c.sqlite")
    cache.put("k", b"v")
    assert cache.get("k") == b"v" and cache.get("x") is None


def test_embed_serves_hits_from_the_cache_without_a_call(tmp_path, monkeypatch):
    cache, spend = cloud.Cache(tmp_path / "c.sqlite"), cloud.Spend(tmp_path / "s.jsonl")
    cache.put(cloud.cache_key(cloud.EMBED_MODEL, "a"), np.array([1, 0], dtype=np.float32).tobytes())
    calls = []
    monkeypatch.setattr(cloud, "api_key", lambda: "k")

    def fake_post(path, body, key):
        calls.append(body["input"])
        return {"data": [{"index": i, "embedding": [0.0, 1.0]} for i in range(len(body["input"]))], "usage": {}}

    monkeypatch.setattr(cloud, "_post", fake_post)
    out = cloud.embed(["a", "b", "a"], cache, spend)
    assert calls == [["b"]]
    assert out.tolist() == [[1, 0], [0, 1], [1, 0]]
    assert cloud.embed(["b"], cache, spend).tolist() == [[0, 1]] and len(calls) == 1
