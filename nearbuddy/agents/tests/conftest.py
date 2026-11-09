import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import export_dataset  # noqa: E402
import runner  # noqa: E402


@pytest.fixture(autouse=True)
def attest_dir(tmp_path, monkeypatch):
    """Each test's own attestation folder: runner.save_attestation writes there and check_row (and the card snippet in
    the tests) reads from there, so no test touches agents/data/attestations."""
    d = tmp_path / "attestations"
    d.mkdir()
    monkeypatch.setattr(runner, "ATTEST_DIR", d)
    monkeypatch.setattr(export_dataset, "ATTEST_DIR", d)
    monkeypatch.setattr(runner, "_attest_refetched", {})  # no test's refetch throttles another's
    return d
