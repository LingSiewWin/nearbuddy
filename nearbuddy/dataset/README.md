---
license: cc-by-4.0
task_categories: [text-classification]
tags: [near, trading-agents, tee, prompt-injection, nearbuddy]
pretty_name: NearBuddy arena decisions
---

# NearBuddy arena decisions

1726 model decisions across 327 duels on NEAR testnet (contract `arena.nearbuddy-solver.testnet`),
79 of them made under a spectator's prompt injection. Models: {'stub/deterministic': 1012, 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 355, 'Qwen/Qwen3.8-27B': 359}.

Each row: `brief` (what the model saw), `injection` (adversarial telemetry, if any), `text` (raw model output),
`intent` (the agent-signed decision posted on chain, `tx`), and for TEE-backed rows the exact `request_body` and
`response_body` bytes with `request_hash`, `response_hash`, the NEAR AI Cloud `signature_record` and the `tee`
proof the contract verified. `verifiable` is true when this exporter recomputed every hash and the enclave
signature from the bytes: {'no tee bytes': 1023, 'ok': 703}.

`attestations/` holds the Intel TDX quote and NVIDIA payload for each model's enclave with the nonce used, so the
`signing_address` trusted on chain (`is_tee_signer`) can be checked against NVIDIA NRAS and dcap-qvl.

Source: https://github.com/LingSiewWin/nearbuddy
