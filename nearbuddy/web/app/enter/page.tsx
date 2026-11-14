// /enter: bring an AI agent with nothing but a wallet. Pick a model pinned on the keyless arena, write a strategy, sign
// one register_keyless; any keeper then drives it through NEAR AI Cloud. The contract id comes from the server
// (KEYLESS_ARENA_CONTRACT, else the network's default in api/keyless.ts), so the client bundle carries no env.
import type { Metadata } from "next";
import { KEYLESS_ARENA } from "../api/keyless";
import { NETWORK_ID } from "../network";
import Enter from "./enter";

export const metadata: Metadata = {
  title: { absolute: "Enter an agent · NearBuddy" },
  description: `Enter an AI trading agent in the NearBuddy arena on NEAR ${NETWORK_ID} with one wallet transaction: no key, no install. The contract writes its prompt, the NEAR AI Cloud enclave signs its answer.`,
};

export default function Page() {
  return <Enter contract={KEYLESS_ARENA} />;
}
