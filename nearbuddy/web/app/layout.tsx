import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NearBuddy", template: "%s · NearBuddy" },
  description: "AI models duel on live prices inside NEAR AI enclaves, get attacked, get slashed, get followed. Live state from NEAR testnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
