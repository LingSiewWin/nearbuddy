// The web's network switch: explorer links follow the network, web/app/network.ts stays a byte copy of the
// protocol table, and next.config.ts derives NEXT_PUBLIC_NEAR_NETWORK from NEAR_NETWORK so the two cannot differ.
// Child processes pick the network at import, as in a real build, whatever the rest of the suite imported first.
// Run: `cd web && bun test`.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OVERRIDES } from "../network";

const WEB = `${import.meta.dir}/../..`;

const child = (script: string, vars: Record<string, string>) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["NEAR_NETWORK", "NEXT_PUBLIC_NEAR_NETWORK", ...OVERRIDES]) delete env[k];
  const p = Bun.spawnSync(["bun", "--no-env-file", "-e", script], { cwd: WEB, env: { ...env, ...vars } });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
};

const render = `
import { renderToStaticMarkup } from "react-dom/server";
import { addrHref, blockHref, linkRow, NET, txHref } from "./app/tui";
console.log(JSON.stringify({
  html: renderToStaticMarkup(linkRow("tx", "open ", "9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB", "")),
  tx: txHref("H"), addr: addrHref("a.near"), block: blockHref("7"), oracle: NET.oracle, arena: NET.arena,
}));`;

// what a client component sees: only the inlined NEXT_PUBLIC_NEAR_NETWORK
const clientView = (network: string) => {
  const r = child(render, { NEXT_PUBLIC_NEAR_NETWORK: network });
  if (!r.ok) throw new Error(r.err);
  return JSON.parse(r.out) as Record<string, string>;
};

const publicNetwork = (vars: Record<string, string>) =>
  child('import c from "./next.config.ts"; console.log(c.env?.NEXT_PUBLIC_NEAR_NETWORK)', vars);

test("mainnet: every explorer link goes to nearblocks.io and the oracle is price-oracle.near", () => {
  const m = clientView("mainnet");
  expect(m.html).toContain('href="https://nearblocks.io/txns/9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB"');
  expect(m.html).not.toContain("testnet");
  expect(m.tx).toBe("https://nearblocks.io/txns/H");
  expect(m.addr).toBe("https://nearblocks.io/address/a.near");
  expect(m.block).toBe("https://nearblocks.io/blocks/7");
  expect(m.oracle).toBe("price-oracle.near");
  expect(m.arena).toBe("arena.nearbuddy.near");
});

test("testnet (the default row) keeps testnet.nearblocks.io", () => {
  const t = clientView("testnet");
  expect(t.html).toContain('href="https://testnet.nearblocks.io/txns/9Hf33');
  expect(t.oracle).toBe("price-oracle.testnet");
});

test("web/app/network.ts is a byte copy of packages/protocol/src/network.ts", () => {
  const web = readFileSync(`${WEB}/app/network.ts`, "utf8");
  const protocol = readFileSync(`${WEB}/../packages/protocol/src/network.ts`, "utf8");
  expect(web).toBe(protocol);
});

test("next.config derives NEXT_PUBLIC_NEAR_NETWORK from NEAR_NETWORK and refuses a second value", () => {
  expect(publicNetwork({}).out.trim()).toBe("testnet");
  expect(publicNetwork({ NEAR_NETWORK: "mainnet" }).out.trim()).toBe("mainnet");
  expect(publicNetwork({ NEAR_NETWORK: "mainnet", NEXT_PUBLIC_NEAR_NETWORK: "mainnet" }).out.trim()).toBe("mainnet");
  const split = publicNetwork({ NEAR_NETWORK: "mainnet", NEXT_PUBLIC_NEAR_NETWORK: "testnet" });
  expect(split.ok).toBe(false);
  expect(split.err).toContain("NEXT_PUBLIC_NEAR_NETWORK=testnet disagrees with NEAR_NETWORK=mainnet");
  const mixed = publicNetwork({ NEAR_NETWORK: "mainnet", NEAR_RPC: "https://near-testnet.drpc.org" });
  expect(mixed.ok).toBe(false); // the build stops on a mixed config too
});
