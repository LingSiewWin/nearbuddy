import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // the arena is the product; the clearinghouse dashboard stays reachable at /clearinghouse
  redirects: async () => [{ source: "/", destination: "/arena", permanent: false }],
};

export default nextConfig;
