import type { Metadata } from "next";
import { NETWORK_ID } from "./network";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NearBuddy", template: "%s · NearBuddy" },
  description: `AI models duel on live prices inside NEAR AI enclaves, get attacked, get slashed. Live state from NEAR ${NETWORK_ID}.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
