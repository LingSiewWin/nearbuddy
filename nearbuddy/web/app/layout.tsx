import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NearBuddy · live",
  description: "Zero-balance credit clearinghouse for AI agents on NEAR. Live testnet state.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
