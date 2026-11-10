// Content-Security-Policy with a fresh nonce per page request. Next reads the nonce back from the request's CSP
// header and stamps it on every inline script it renders per request, including the resume of a partially
// prerendered page. A prerendered shell carries no nonce: its <script src> tags pass by 'self' and React's one inline
// timing script by its hash, so there is no 'strict-dynamic' (it would switch 'self' off). A route with no dynamic
// part at all is served whole from the prerender, inline payload unnonced, and that payload is blocked: the root
// layout keeps one dynamic hole so that every page resumes per request.
import { type NextRequest, NextResponse } from "next/server";
import { NET } from "./app/network";

// React's `$RT` timing script, the only inline script a prerendered shell carries outside the nonced resume.
const REACT_RT = "'sha256-7mu4H06fwDCjmnxxr/xNHyuQC6pLTHr4M2E4jXw5WZs='";

// NEAR Connect (app/lib/wallet.ts) fetches its wallet list and each wallet's code, then runs that code in a sandboxed
// srcdoc iframe, which inherits this policy: what the wallets it lists on testnet reach goes here, each driven to its
// first screen in a browser (rpc.testnet.near.org and api.testnet.fastnear.com read from the NEAR CLI and Ledger code).
// A mainnet build lists more wallets (HOT, MyNearWallet, OKX, ...) whose origins are not here yet.
const WALLET = {
  connect: [
    "https://raw.githubusercontent.com", // wallet list, and the code of Meteor, Ledger, Nightly, NEAR CLI
    "https://cdn.jsdelivr.net", // wallet list fallback
    "https://wallet.intear.tech", // Intear code
    "wss://logout-bridge-service.intear.tech", // Intear sign-out bridge
    "https://evm-on-near.dev", // Ethereum Wallets code
    "https://mc.meteorwallet.app", // Meteor connect backend
    "wss://mc.meteorwallet.app",
    "https://rpc.testnet.near.org", // NEAR CLI and Ledger RPC
    "https://api.testnet.fastnear.com", // Ledger account lookup
  ],
  img: [
    "https://raw.githubusercontent.com", // Meteor icon
    "https://storage.herewallet.app", // Nightly icon
    "https://evm-on-near.dev", // Ethereum Wallets icon
    "https://meteorwallet.app", // Meteor loader
  ],
  fonts: ["https://rsms.me", "https://fonts.cdnfonts.com"], // Meteor and NEAR CLI stylesheets and their fonts
  frame: ["https://wallet.intear.tech"], // Intear's own iframe inside its sandbox
};
// Browser-side reads and sends on this build's network (Meteor and Nightly also use the fallback).
const RPC = [NET.rpc, NET.fallback, NET.txApi].map((u) => new URL(u).origin);

function policy(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  const list = (xs: string[]) => [...new Set(xs)].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${REACT_RT}${dev ? " 'unsafe-eval'" : ""}`, // React debugging evals in dev
    // NEAR Connect's picker appends an unnonced <style> and style="" attributes, and the terminal sets style=""
    `style-src 'self' 'unsafe-inline' ${list(WALLET.fonts)}`,
    `font-src 'self' data: ${list(WALLET.fonts)}`,
    `img-src 'self' data: blob: ${list(WALLET.img)}`,
    `connect-src 'self' ${list([...RPC, ...WALLET.connect])}`,
    `frame-src ${list(WALLET.frame)}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const csp = policy(btoa(crypto.randomUUID()));
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

// Pages only: api routes answer JSON, text or images (next.config.ts gives them a deny-all policy), and router
// prefetches carry no HTML to protect.
export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
