import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { NETWORK_ID } from "./network";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NearBuddy", template: "%s · NearBuddy" },
  description: `AI models duel on live prices inside NEAR AI enclaves, get attacked, get slashed. Live state from NEAR ${NETWORK_ID}.`,
};

// proxy.ts puts a fresh CSP nonce on each page request, and Next stamps it only on what it renders per request. This
// empty dynamic hole makes every page resume per request, so its inline payload carries the nonce instead of being
// served unnonced (and blocked) from the prerender.
async function PerRequest() {
  await connection();
  return null;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Suspense>
          <PerRequest />
        </Suspense>
      </body>
    </html>
  );
}
