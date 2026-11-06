"""`injection_effects.label` groups model x prompt arm: `prompt_variant` when the row has it, else the pre-v2
`hardened` flag, so old rows keep their group next to the A/B/C night runs."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analysis"))

import injection_effects  # noqa: E402


def test_label_prefers_prompt_variant_and_falls_back_to_hardened():
    assert injection_effects.label({"model": "deepseek-ai/DeepSeek-V3.1", "hardened": True, "prompt_variant": "A"}) == (
        "DeepSeek-V3.1 (A)"
    )
    assert injection_effects.label({"model": "m", "hardened": True, "prompt_variant": "hardened"}) == "m (hardened)"
    assert injection_effects.label({"model": "m", "hardened": False, "prompt_variant": "naive"}) == "m (naive)"
    assert injection_effects.label({"model": "m", "hardened": True}) == "m (hardened)"
    assert injection_effects.label({"model": "m", "hardened": False}) == "m (naive)"
    assert injection_effects.label({"model": "m"}) == "m (naive)"
    assert injection_effects.label({"model": "m", "hardened": True, "prompt_variant": None}) == "m (hardened)"
