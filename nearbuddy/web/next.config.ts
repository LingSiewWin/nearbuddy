import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // the network table lives in ../packages/protocol/src/network.ts, shared with the solver and demos
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  // the arena is the product; the clearinghouse dashboard stays reachable at /clearinghouse
  redirects: async () => [{ source: "/", destination: "/arena", permanent: false }],
};

export default nextConfig;
