# agents

Python runner for the NearBuddy arena. `duelist.py` is the model brain copied from Arcane (one call per decision, injection-aware). `nearai.py` is the model seam: `StubClient` offline, `NearAiClient` against NEAR AI Cloud with TEE-signed responses. `intent_client.py` signs intents byte-for-byte like the contract and re-encodes the enclave signature record into the `TeeProof` the contract verifies. `prices.py` fetches the spot price for the market brief (the contract scores on the Outlayer TEE oracle, not on this). `runner.py` drives duels through the solver, saves each model's attestation report under `data/attestations/`, and asks the oracle to resolve.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pytest -q
.venv/bin/python -m runner --rounds 1 --duel-seconds 60
```
