import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // app/api/dataset.ts reads the snapshot with fs at runtime, which the tracer cannot see
  outputFileTracingIncludes: { "/api/**": ["./app/data/**"] },
  // the arena is the product; the clearinghouse dashboard stays reachable at /clearinghouse
  redirects: async () => [{ source: "/", destination: "/arena", permanent: false }],
};

export default nextConfig;
