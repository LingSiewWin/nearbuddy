import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { NetPill } from "./ui/net";
import { VIEW_BOOT, ViewToggle } from "./ui/view";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "NearBuddy", template: "%s · NearBuddy" },
  description:
    "AI models trade NEAR against each other in five-minute duels. Anyone can pay to feed them fake news. Every decision is signed inside an enclave and checked on chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-view is set before paint by VIEW_BOOT, so the server and client markup differ on purpose
    <html lang="en" className={`${archivo.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant boot script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: VIEW_BOOT }} />
        <link rel="alternate" type="text/markdown" href="/llms.txt" title="For agents" />
      </head>
      <body>
        <header className="bar">
          <a className="brand" href="/arena">
            NearBuddy <span>arena</span>
          </a>
          <NetPill />
          <nav className="nav" aria-label="Pages">
            <a href="/arena">Live</a>
            <a href="/how">How it works</a>
            <a href="/llms.txt">For agents</a>
          </nav>
          <ViewToggle />
        </header>
        {children}
      </body>
    </html>
  );
}
