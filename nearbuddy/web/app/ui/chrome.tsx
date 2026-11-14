"use client";
// The frame every page of the Trace design sits in: header with navigation and the account control, footer with the
// network, theme toggle and the Terminal link, the sign-in sheet, and the one polite live region status changes are
// announced through. Wallet and guest accounts are lib/wallet.ts and lib/guest.ts, unchanged.
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { recall } from "../lib/guest";
import * as wallet from "../lib/wallet";
import { NETWORK_ID } from "../network";
import { REPO } from "../tui";
import { guestLabel, shortId } from "./format";
import { Button, Sheet, StatusBar } from "./kit";

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
};
const Ctx = createContext<Site>({
  account: null,
  kind: "none",
  ready: false,
  signIn: async () => null,
  announce: () => {},
});
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
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME);
      if (t === "light" || t === "dark") {
        document.documentElement.dataset.theme = t;
        setTheme(t);
      }
    } catch {}
  }, []);
  const shown = (): Theme => theme ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  return (
    <button
      type="button"
      className="btn-link"
      onClick={() => {
        const next: Theme = shown() === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME, next);
        } catch {}
        setTheme(next);
      }}
    >
      Switch theme
    </button>
  );
}

// ---------------------------------------------------------------- sign-in sheet and account menu

function SignIn({ open, onDone }: { open: boolean; onDone: (account: string | null) => void }) {
  const [busy, setBusy] = useState<"guest" | "wallet" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (which: "guest" | "wallet") => {
    setBusy(which);
    setError(null);
    try {
      const a = which === "guest" ? await wallet.guestSignIn() : await wallet.signIn();
      if (a) onDone(a);
    } catch {
      if (which === "guest")
        setError("Could not make a guest account. The test faucet did not answer. Try again, or connect a wallet.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={open} onClose={() => onDone(null)} title="Sign in" locked={busy === "guest"}>
      {error ? <StatusBar kind="error">{error}</StatusBar> : null}
      {/* guest accounts exist on testnet only: on mainnet the button is absent, not disabled */}
      {NETWORK_ID === "testnet" ? (
        <div className="choice">
          <Button
            variant="primary"
            busy={busy === "guest" ? "Making your account…" : null}
            onClick={() => run("guest")}
          >
            Play as guest
          </Button>
          <p className="t-small">No wallet needed. We make a temporary test account in this browser.</p>
        </div>
      ) : null}
      <div className="choice">
        <Button variant="quiet" disabled={busy !== null} onClick={() => run("wallet")} style={{ width: "100%" }}>
          Connect a wallet
        </Button>
        <p className="t-small">Use your own NEAR account.</p>
      </div>
    </Sheet>
  );
}

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

const NAV = [
  ["/arena", "Duels"],
  ["/board", "Scoreboard"],
  ["/evidence", "Evidence"],
  ["/enter", "Enter an agent"],
] as const;

export function Chrome({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [menu, setMenu] = useState(false);
  const [nav, setNav] = useState(false);
  const [said, setSaid] = useState("");
  const waiting = useRef<((a: string | null) => void)[]>([]);
  // the account a previous visit left (a guest in this browser, or a connected wallet), then sign-in and sign-out
  useEffect(() => {
    let alive = true;
    let off = () => {};
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
  };
  return (
    <Ctx.Provider value={site}>
      <div className="site">
        <header className="site-header">
          <div className="bar">
            <a className="wordmark" href="/">
              NearBuddy
            </a>
            <nav className={`site-nav${nav ? " open" : ""}`} id="site-nav" aria-label="Main">
              {NAV.map(([href, label]) => (
                <a key={href} href={href}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="account">
              {account ? (
                <button type="button" className="btn btn-quiet account-button" onClick={() => setMenu(true)}>
                  {kind === "guest" ? guestLabel(account) : <span className="mono">{shortId(account, 12, 8)}</span>}
                </button>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={() => site.signIn()}>
                  Sign in
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn btn-quiet menu-button"
              aria-label="Menu"
              aria-expanded={nav}
              aria-controls="site-nav"
              onClick={() => setNav((v) => !v)}
            >
              ☰
            </button>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <div className="bar">
            <span className="mono">{NETWORK_ID}</span>
            <ThemeToggle />
            <a href="/terminal">Terminal</a>
            <a href={REPO} target="_blank" rel="noreferrer">
              Source
            </a>
          </div>
        </footer>
        <div className="sr" aria-live="polite">
          {said}
        </div>
      </div>
      <SignIn open={signingIn} onDone={done} />
      {account ? <AccountMenu open={menu} onClose={() => setMenu(false)} account={account} kind={kind} /> : null}
    </Ctx.Provider>
  );
}
