"use client";
// The frame every page of the Trace design sits in: header with navigation and the account control, footer with the
// network, theme toggle and the Terminal link, the sign-in sheet, and the one polite live region status changes are
// announced through. Wallet and guest accounts are lib/wallet.ts and lib/guest.ts, unchanged.
import { createContext, type ReactNode, Suspense, useContext, useEffect, useRef, useState } from "react";
import type { DuelList, DuelRow } from "../api/list/route";
import { recall } from "../lib/guest";
import * as wallet from "../lib/wallet";
import { NET, NETWORK_ID } from "../network";
import { addrHref, REPO } from "../tui";
import { DoodleCrewFooter, type FooterColumn } from "./doodle-crew-footer";
import { guestLabel, shortId } from "./format";
import { Button, type Read, Sheet, useNow, useRead } from "./kit";
import { FOOT, NAV } from "./nav";
import { pickLive } from "./verdict";
import { VerifyDrawer } from "./verify";
import { WalletSignIn } from "./wallet-sign-in";

type Kind = "none" | "guest" | "wallet";
type Site = {
  /** The signed-in account, or null. `ready` is false until the first read. */
  account: string | null;
  kind: Kind;
  ready: boolean;
  /** Opens the sign-in sheet; resolves with the account once signed in, or null when the sheet is closed. */
  signIn: () => Promise<string | null>;
  /** Says a status change through the page's live region. */
  announce: (text: string) => void;
  /** The duel list of both arenas (/api/list), read once for the whole page: every 60 s, stale after 5 minutes. */
  list: Read<DuelList>;
};
const Ctx = createContext<Site>({
  account: null,
  kind: "none",
  ready: false,
  signIn: async () => null,
  announce: () => {},
  list: { data: null, error: null, loading: true, slow: false, stale: false, age: 0, retry: () => {} },
});
/** What the product is, in one line: the README, the page descriptions and the footer say the same thing. */
const TAGLINE =
  "A public stress test for AI trading agents: bonded, open to attack by anyone, every decision signed in an enclave.";

export const useSite = () => useContext(Ctx);

// ---------------------------------------------------------------- headlines planted from this browser

/** `index`: the headline's place in the duel's get_chaos, when the call returned it. */
export type Mine = { tx: string; duel: string; arena: "main" | "keyless"; at: number; index: number | null };
const MINE = "nb:headlines";
/** Every attack made from this browser, newest first (the account menu's "Your headlines"). */
export function myHeadlines(): Mine[] {
  try {
    const v = JSON.parse(localStorage.getItem(MINE) ?? "[]") as Mine[];
    return Array.isArray(v) ? v.filter((m) => typeof m?.tx === "string") : [];
  } catch {
    return [];
  }
}
export function rememberHeadline(m: Mine) {
  try {
    localStorage.setItem(MINE, JSON.stringify([m, ...myHeadlines().filter((x) => x.tx !== m.tx)].slice(0, 100)));
  } catch {} // storage blocked: the link in the address bar still works
}

// ---------------------------------------------------------------- theme

type Theme = "light" | "dark";
const THEME = "nb:theme";
function readLiveTheme(): Theme {
  const live = document.documentElement.dataset.theme;
  if (live === "light" || live === "dark") return live;
  try {
    const stored = localStorage.getItem(THEME);
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function ThemeToggle({ className }: { className?: string } = {}) {
  // null until mount so SSR markup stays stable; icon defaults to sun (offer light).
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const apply = () => {
      const t = readLiveTheme();
      document.documentElement.dataset.theme = t;
      setTheme(t);
    };
    apply();
    const mo = new MutationObserver(() => setTheme(readLiveTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  const current: Theme = theme ?? "dark";
  const toLight = current === "dark";
  return (
    <button
      type="button"
      className={["theme-toggle", className].filter(Boolean).join(" ")}
      aria-label={toLight ? "Switch to light theme" : "Switch to dark theme"}
      title={toLight ? "Light" : "Dark"}
      onClick={() => {
        const next: Theme = current === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME, next);
        } catch {}
        setTheme(next);
      }}
    >
      {toLight ? (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.05 5.05l1.55 1.55M17.4 17.4l1.55 1.55M5.05 18.95l1.55-1.55M17.4 6.6l1.55-1.55" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M14.6 3.1a8.6 8.6 0 1 0 6.3 14.2A7.2 7.2 0 0 1 14.6 3.1Z" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- account menu (connect gate is WalletSignIn)

function AccountMenu({
  open,
  onClose,
  account,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  account: string;
  kind: Kind;
}) {
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  useEffect(() => {
    if (open) setMine(myHeadlines());
    else {
      setConfirm(false);
      setCopied(false);
    }
  }, [open]);
  const leave = () => wallet.signOut().finally(onClose);
  return (
    <Sheet open={open} onClose={onClose} title="Account">
      <div className="stack">
        <p className="t-mono">{account}</p>
        {kind === "guest" ? (
          confirm ? (
            <div className="stack">
              <p>Delete this guest account? Money still locked in a running duel cannot be collected afterwards.</p>
              <div className="hrow">
                <Button variant="quiet" onClick={leave}>
                  Delete
                </Button>
                <Button variant="quiet" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <p>This account lives only in this browser. Clearing site data deletes it.</p>
              <div className="hrow">
                <Button
                  variant="quiet"
                  onClick={() => {
                    const key = recall()?.privateKey;
                    if (key) navigator.clipboard.writeText(key).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy key"}
                </Button>
                <Button variant="quiet" onClick={() => setConfirm(true)}>
                  Delete guest account
                </Button>
              </div>
            </div>
          )
        ) : (
          <Button variant="quiet" onClick={leave}>
            Sign out
          </Button>
        )}
        {mine.length ? (
          <div className="stack-2">
            <h3 className="t-label">Your headlines</h3>
            <ul>
              {mine.map((m) => (
                <li key={m.tx}>
                  <a className="btn-link" href={`/i/${m.tx}`}>
                    {`Duel #${m.duel} · `}
                    <span className="mono">{shortId(m.tx, 8, 0)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- the frame

const path = (r: DuelRow, extra = "") =>
  `/duel/${r.id}${r.arena === "keyless" || extra ? "?" : ""}${[r.arena === "keyless" ? "arena=keyless" : "", extra].filter(Boolean).join("&")}`;
const verifyOf = (r: DuelRow) => `?verify=${r.arena === "keyless" ? "keyless%3A" : ""}${r.id}`;

export function Chrome({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [menu, setMenu] = useState(false);
  const [nav, setNav] = useState(false);
  const [headlines, setHeadlines] = useState<Mine[] | null>(null);
  const [mine, setMine] = useState(false);
  const [said, setSaid] = useState("");
  const [at, setAt] = useState<string | null>(null); // the page's path, once mounted
  const waiting = useRef<((a: string | null) => void)[]>([]);
  const list = useRead<DuelList>("/api/list", 60_000, 300_000);
  const now = useNow(15_000);
  // the account a previous visit left (a guest in this browser, or a connected wallet), then sign-in and sign-out
  useEffect(() => {
    let alive = true;
    let off = () => {};
    setAt(location.pathname);
    setMine(myHeadlines().length > 0);
    wallet.account().then((a) => {
      if (!alive) return;
      setAccount(a);
      setReady(true);
    });
    wallet
      .onChange((a) => alive && setAccount(a))
      .then((f) => {
        off = f;
      });
    return () => {
      alive = false;
      off();
    };
  }, []);
  const kind: Kind = !account ? "none" : recall()?.accountId === account ? "guest" : "wallet";
  const done = (a: string | null) => {
    setSigningIn(false);
    if (a) setAccount(a);
    for (const f of waiting.current.splice(0)) f(a);
  };
  const site: Site = {
    account,
    kind,
    ready,
    signIn: () =>
      new Promise((resolve) => {
        waiting.current.push(resolve);
        setSigningIn(true);
      }),
    announce: setSaid,
    list,
  };
  const rows = list.data?.duels ?? [];
  const live = now ? pickLive(rows, now, (r) => list.data?.lock_s[r.arena] ?? 0) : null;
  const last = rows.find((r) => r.resolved && !r.cancelled) ?? null;
  // the header's one button: hidden on the landing page and on a duel page, where the page's own action is on screen
  const cta =
    at === null || at === "/" || at.startsWith("/duel/") ? null : live ? (
      <a className="btn btn-attack cta" href={path(live)}>
        Attack an AI
      </a>
    ) : last ? (
      <a className="btn btn-quiet cta" href={path(last)}>
        See the last duel
      </a>
    ) : null;
  const control = account ? (
    <button type="button" className="btn btn-quiet account-button" onClick={() => setMenu(true)}>
      {kind === "guest" ? guestLabel(account) : <span className="mono">{shortId(account, 12, 8)}</span>}
    </button>
  ) : (
    <button type="button" className="btn-dcf btn-dcf-solid" onClick={() => site.signIn()}>
      <svg className="btn-dcf-icon" viewBox="-16 -16 32 32" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M3 -14 L-8 2 L-1 2 L-4 14 L8 -3 L1 -3 Z" />
      </svg>
      <span>Connect wallet</span>
    </button>
  );
  const link = (href: string, label: string) => (
    <a key={href} href={href} aria-current={at === href ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <Ctx.Provider value={site}>
      <div className="site">
        <header className="site-header">
          <div className="bar">
            <a className="wordmark" href="/">
              NearBuddy
            </a>
            <nav className="site-nav" aria-label="Main">
              {NAV.map((l) => link(l.href, l.label))}
            </nav>
            <div className="account">{control}</div>
            {cta}
            <ThemeToggle />
            <button type="button" className="btn btn-quiet menu-button" aria-label="Menu" onClick={() => setNav(true)}>
              ☰
            </button>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <DoodleCrewFooter
          className="site-footer"
          preset="night"
          wordmark="NEARBUDDY"
          brand="NearBuddy"
          blurb={TAGLINE}
          tagline="Bonded agents. Open attacks. Enclave-signed decisions."
          columns={
            [
              {
                title: "Play",
                links: [...(live ? [{ label: "Live duel", href: path(live) }] : []), ...FOOT.play],
              },
              {
                title: "Proof",
                links: [
                  ...FOOT.proof,
                  {
                    label: "Dataset",
                    href: `${REPO}/tree/HEAD/nearbuddy/dataset#readme`,
                  },
                  ...(last ? [{ label: "Verify last duel", href: verifyOf(last) }] : []),
                ],
              },
              {
                title: "Build",
                links: [...FOOT.build, { label: "Source", href: REPO }],
              },
              {
                title: "Reach us",
                links: [
                  { label: "X", href: "https://x.com/siewwwin" },
                  { label: "LinkedIn", href: "https://www.linkedin.com/in/ling-siew-win/" },
                  { label: "Email", href: "mailto:siewwwin@gmail.com" },
                ],
              },
            ] satisfies FooterColumn[]
          }
          actions={[
            { label: "Enter an agent", href: "/enter", icon: "bolt", variant: "outline" },
            { label: "Try to fool one", href: "/#chapter-3", icon: "flame", variant: "solid" },
          ]}
          copyright="NearBuddy"
          legal={[]}
          socials={[
            { label: "X", href: "https://x.com/siewwwin" },
            { label: "LinkedIn", href: "https://www.linkedin.com/in/ling-siew-win/" },
            { label: "Email", href: "mailto:siewwwin@gmail.com" },
          ]}
          barExtra={
            <>
              <span>
                arena{" "}
                <a className="mono" href={addrHref(NET.arena)} target="_blank" rel="noreferrer">
                  {NET.arena} ↗
                </a>
              </span>
              <span>
                network <span className="mono">{NETWORK_ID}</span>
              </span>
              <ThemeToggle />
              {mine ? (
                <button type="button" className="btn-link" onClick={() => setHeadlines(myHeadlines())}>
                  Your headlines
                </button>
              ) : null}
            </>
          }
        />
        <div className="sr" aria-live="polite">
          {said}
        </div>
      </div>
      <Sheet open={nav} onClose={() => setNav(false)} title="Menu" kind="drawer">
        <nav className="menu-list" aria-label="Menu">
          {NAV.map((l) => link(l.href, l.label))}
        </nav>
        <div className="menu-foot">
          {control}
          <ThemeToggle />
        </div>
      </Sheet>
      <Sheet open={headlines !== null} onClose={() => setHeadlines(null)} title="Your headlines">
        <ul>
          {(headlines ?? []).map((m) => (
            <li key={m.tx}>
              <a className="btn-link" href={`/i/${m.tx}`}>
                {`Duel #${m.duel} · `}
                <span className="mono">{shortId(m.tx, 8, 0)}</span>
              </a>
            </li>
          ))}
        </ul>
      </Sheet>
      <Suspense>
        <VerifyDrawer />
      </Suspense>
      <WalletSignIn open={signingIn} onDone={done} />
      {account ? <AccountMenu open={menu} onClose={() => setMenu(false)} account={account} kind={kind} /> : null}
    </Ctx.Provider>
  );
}
