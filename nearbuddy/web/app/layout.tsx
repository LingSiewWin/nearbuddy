import type { Metadata } from "next";
import { IBM_Plex_Sans, Newsreader } from "next/font/google";
import { connection } from "next/server";
import { Suspense } from "react";
import { NETWORK_ID } from "./network";
import { Chrome } from "./ui/chrome";
import "./globals.css";
import "./ui/ui.css";

// Three voices: sans for the instrument, serif for a planted headline; the machine speaks in the system monospace.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans" });
const serif = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-serif" });

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
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <Chrome>{children}</Chrome>
        <Suspense>
          <PerRequest />
        </Suspense>
      </body>
    </html>
  );
}
