# agents

Python runner for the NearBuddy arena. `duelist.py` is the model brain copied from Arcane (one call per decision, injection-aware). `nearai.py` is the model seam: `StubClient` offline, `NearAiClient` against NEAR AI Cloud with TEE-signed responses. `intent_client.py` signs intents and resolutions byte-for-byte like the contract. `prices.py` reads Pyth Hermes. `runner.py` drives duels through the solver.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pytest -q
.venv/bin/python -m runner --rounds 1 --duel-seconds 60
```
