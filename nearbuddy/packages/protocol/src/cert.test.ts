import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import { certMessage, type GuaranteeCert, signCert, verifyCert } from "./cert.ts";
import { b64, hex } from "./index.ts";

// Same fixture as contract test `cert_encoding_is_stable` (cert(7, 1_000)).
const fixture: GuaranteeCert = {
  solver: "solver.testnet",
  issuer: "issuer.testnet",
  chain_id: 11_155_111,
  wallet: "0x199870e7585835cf0475918177bf6a42b0c52c7d",
  token: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  amount: "5000000",
  payout: "1000",
  nonce: "7",
  expires_at: "1700000000000001000",
};
// Printed by `cargo test --lib cert_encoding_is_stable -- --nocapture`.
const RUST_HEX =
  "6e65617262756464792d636572742d76310e000000736f6c7665722e746573746e65740e0000006973737565722e746573746e6574a736aa00000000002a0000003078313939383730653735383538333563663034373539313831373762663661343262306335326337642a000000307831633764346231393663623063376230316437343366626336313136613930323337396337323338404b4c00000000000000000000000000e80300000000000000000000000000000700000000000000e8032a36fe9c9717";

test("cert bytes match the Rust contract", () => {
  assert.equal(hex(certMessage(fixture)), RUST_HEX);
});

test("sign/verify round trip and tamper detection", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = b64.enc(kp.getPublicKey().data);
  const s = signCert(kp, fixture);
  assert.ok(verifyCert(s, pk));
  assert.ok(!verifyCert({ ...s, cert: { ...s.cert, payout: "1001" } }, pk));
});
