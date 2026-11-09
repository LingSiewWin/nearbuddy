# agents

Python runner for the NearBuddy arena. `duelist.py` is the model brain copied from Arcane (one call per decision, injection-aware). `nearai.py` is the model seam: `StubClient` offline, `NearAiClient` against NEAR AI Cloud with TEE-signed responses. `intent_client.py` signs intents byte-for-byte like the contract and re-encodes the enclave signature record into the `TeeProof` the contract verifies. `prompts.py` holds the hardened and naive prompts the duel compares. `prices.py` fetches the spot price for the market brief (the contract scores on the Outlayer TEE oracle, not on this). `keys.py` derives the agents' ed25519 keys from the env file and signs the registration proof; `chain.py` reads the arena contract over RPC; `config.py` merges `.env` with the process environment. `runner.py` is the CLI and loop: it drives duels through the solver, saves each model's attestation report under `data/attestations/`, and asks the oracle to resolve.

```sh
uv sync  # .venv from uv.lock on the Python in .python-version (3.13)
.venv/bin/pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy .
.venv/bin/python -m runner --rounds 1 --duel-seconds 60
```
