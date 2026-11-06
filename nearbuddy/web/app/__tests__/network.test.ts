// Explorer links follow NEXT_PUBLIC_NEAR_NETWORK. Rendered in a child process so the network is picked at
// import, as in a real build, whatever the rest of the suite imported first.
// Run: `cd web && bun test`.
import { expect, test } from "bun:test";

const render = `
import { renderToStaticMarkup } from "react-dom/server";
import { addrHref, blockHref, linkRow, NET, txHref } from "./app/tui";
console.log(JSON.stringify({
  html: renderToStaticMarkup(linkRow("tx", "open ", "9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB", "")),
  tx: txHref("H"), addr: addrHref("a.near"), block: blockHref("7"), oracle: NET.oracle, arena: NET.arena,
}));`;

const run = (network: string) => {
  const env: Record<string, string | undefined> = { ...process.env, NEXT_PUBLIC_NEAR_NETWORK: network };
  delete env.NEAR_NETWORK;
  const p = Bun.spawnSync(["bun", "-e", render], { cwd: `${import.meta.dir}/../..`, env });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString()) as Record<string, string>;
};

test("mainnet: every explorer link goes to nearblocks.io and the oracle is price-oracle.near", () => {
  const m = run("mainnet");
  expect(m.html).toContain('href="https://nearblocks.io/txns/9Hf33mxhDRJMXpPJU2c5TsKFyYmUDXC5z99imSTGxZWB"');
  expect(m.html).not.toContain("testnet");
  expect(m.tx).toBe("https://nearblocks.io/txns/H");
  expect(m.addr).toBe("https://nearblocks.io/address/a.near");
  expect(m.block).toBe("https://nearblocks.io/blocks/7");
  expect(m.oracle).toBe("price-oracle.near");
  expect(m.arena).toBe("arena.nearbuddy.near");
});

test("testnet (the default row) keeps testnet.nearblocks.io", () => {
  const t = run("testnet");
  expect(t.html).toContain('href="https://testnet.nearblocks.io/txns/9Hf33');
  expect(t.oracle).toBe("price-oracle.testnet");
});
