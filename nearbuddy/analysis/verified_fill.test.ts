import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OVERRIDES } from "../packages/protocol/src/network.ts";

test("verified_fill refuses to run off testnet before any RPC call", async () => {
  let hits = 0;
  const rpc = createServer((_req, res) => {
    hits++;
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((ok) => rpc.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  try {
    const run = await new Promise<{ code: number | null; stderr: string }>((done) =>
      execFile(
        process.execPath,
        ["analysis/verified_fill.ts"],
        {
          cwd: `${import.meta.dirname}/..`,
          env: {
            // a local .env must not leak testnet overrides in (env.ts only fills unset keys): blank every override
            ...Object.fromEntries(OVERRIDES.map((k) => [k, ""])),
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NEAR_NETWORK: "mainnet",
            NEAR_RPC: url,
            NEAR_RPC_FALLBACK: url,
            NEAR_SEND_RPC: url,
            SOLVER_RPC: url,
          },
          timeout: 20_000,
        },
        (err, _stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
      ),
    );
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /runs on testnet only, not NEAR_NETWORK=mainnet/);
    assert.equal(hits, 0, "no RPC request left the script");
  } finally {
    rpc.close();
  }
});
