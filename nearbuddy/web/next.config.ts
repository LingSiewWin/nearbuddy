import type { NextConfig } from "next";
import { networkId } from "./app/network";

// One switch: NEAR_NETWORK. Client components read NEXT_PUBLIC_NEAR_NETWORK, so it is derived here (inlined at
// build); a NEXT_PUBLIC_NEAR_NETWORK set to anything else fails the build instead of splitting server and client.
const network = networkId();
if (process.env.NEXT_PUBLIC_NEAR_NETWORK && process.env.NEXT_PUBLIC_NEAR_NETWORK !== network)
  throw new Error(
    `NEXT_PUBLIC_NEAR_NETWORK=${process.env.NEXT_PUBLIC_NEAR_NETWORK} disagrees with NEAR_NETWORK=${network}: set only NEAR_NETWORK`,
  );

// Every response. Pages get their Content-Security-Policy (with a per-request nonce) from proxy.ts; api routes answer
// JSON, text or images, which nosniff keeps from ever being read as HTML or run as a script, even from 'self'.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // nothing here uses these; usb, hid, bluetooth and clipboard stay delegable to the Ledger wallet's iframe
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  env: { NEXT_PUBLIC_NEAR_NETWORK: network },
  // "/" is the league home, "/terminal" the Fool-the-AI terminal; the full record stays at /arena
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
