import json

from reroll.reroll import body_for, decision, p_all, p_any, p_both

PROMPT = {"request_body": '{"model":"m","messages":[],"max_tokens":600,"stream":false}'}


def test_default_replays_recorded_bytes_and_variants_add_fields() -> None:
    assert body_for(PROMPT, "default") == PROMPT["request_body"].encode()
    assert json.loads(body_for(PROMPT, "t0")) == json.loads(PROMPT["request_body"]) | {"temperature": 0}
    assert json.loads(body_for(PROMPT, "t0_seed"))["seed"] == json.loads(body_for(PROMPT, "seed"))["seed"]


def test_keeper_choice_probabilities() -> None:
    assert p_both(2, 0, 8, 8) == 0 and p_both(8, 8, 0, 8) == 0  # one side only: no choice at any k
    assert p_both(8, 1, 7, 8) == 1  # one Long among 8: a keeper drawing all 8 always sees both
    assert abs(p_both(2, 4, 4, 8) - 16 / 28) < 1e-12  # 4 Long, 4 Short: 16 of the 28 pairs are mixed
    assert abs(p_both(2, 1, 1, 8) - 1 / 28) < 1e-12  # 1 Long, 1 Short, 6 unparsed: only that one pair
    assert p_both(8, 1, 6, 8) == 1 and p_both(8, 0, 7, 8) == 0
    assert p_any(1, 2, 8) == 2 / 8 and p_any(8, 1, 8) == 1 and p_any(3, 0, 8) == 0
    assert p_all(8, 8, 8) == 1 and p_all(8, 7, 8) == 0 and p_all(1, 2, 8) == 2 / 8


def test_decision_uses_the_arena_parser() -> None:
    assert decision('{"direction": "SHORT", "size_bps": 2500}') == ("Short", 2500, None)
    assert decision('{"direction": "long"}') == ("Long", None, None)
    side, size, err = decision("no json here")
    assert side is None and size is None and err
