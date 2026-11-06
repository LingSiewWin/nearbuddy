import type { NextConfig } from "next";
import { networkId } from "./app/network";

// One switch: NEAR_NETWORK. Client components read NEXT_PUBLIC_NEAR_NETWORK, so it is derived here (inlined at
// build); a NEXT_PUBLIC_NEAR_NETWORK set to anything else fails the build instead of splitting server and client.
const network = networkId();
if (process.env.NEXT_PUBLIC_NEAR_NETWORK && process.env.NEXT_PUBLIC_NEAR_NETWORK !== network)
  throw new Error(
    `NEXT_PUBLIC_NEAR_NETWORK=${process.env.NEXT_PUBLIC_NEAR_NETWORK} disagrees with NEAR_NETWORK=${network}: set only NEAR_NETWORK`,
  );

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  env: { NEXT_PUBLIC_NEAR_NETWORK: network },
  // the arena is the product; the clearinghouse dashboard stays reachable at /clearinghouse
  redirects: async () => [{ source: "/", destination: "/arena", permanent: false }],
};

export default nextConfig;
