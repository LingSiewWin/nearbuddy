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
import { guestLabel, shortId } from "./format";
import { Button, type Read, Sheet, StatusBar, useNow, useRead } from "./kit";
import { FOOT, NAV } from "./nav";
import { pickLive } from "./verdict";
import { VerifyDrawer } from "./verify";

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
      aria-label="Switch theme"
      onClick={() => {
        const next: Theme = shown() === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME, next);
        } catch {}
        setTheme(next);
      }}
    >
      ◐ theme
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
    <button type="button" className="btn btn-quiet" onClick={() => site.signIn()}>
      Sign in
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
            <span className="tag net-tag">{NETWORK_ID}</span>
            <div className="account">{control}</div>
            {cta}
            <button type="button" className="btn btn-quiet menu-button" aria-label="Menu" onClick={() => setNav(true)}>
              ☰
            </button>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <div className="bar">
            <p className="wordmark">NearBuddy</p>
            <p>A market that puts a price on how hard an AI is to deceive.</p>
            <div className="foot-cols">
              <div>
                <h2 className="t-label">Play</h2>
                {live ? <a href={path(live)}>Live duel</a> : null}
                {FOOT.play.map((l) => link(l.href, l.label))}
                {mine ? (
                  <button type="button" className="btn-link" onClick={() => setHeadlines(myHeadlines())}>
                    Your headlines
                  </button>
                ) : null}
              </div>
              <div>
                <h2 className="t-label">Proof</h2>
                {FOOT.proof.map((l) => link(l.href, l.label))}
                {last ? <a href={verifyOf(last)}>Verify the last duel</a> : null}
              </div>
              <div>
                <h2 className="t-label">Build</h2>
                {FOOT.build.map((l) => link(l.href, l.label))}
                <a href={`${REPO}/tree/HEAD/nearbuddy/dataset#readme`} target="_blank" rel="noreferrer">
                  Dataset
                </a>
              </div>
              <div>
                <h2 className="t-label">Project</h2>
                <a href={REPO} target="_blank" rel="noreferrer">
                  Source code
                </a>
                {FOOT.project.map((l) => link(l.href, l.label))}
              </div>
              <div>
                <h2 className="t-label">Reach us</h2>
                <a href="https://x.com/siewwwin" target="_blank" rel="noreferrer">
                  X
                </a>
                <a href="https://www.linkedin.com/in/lingsiewwin" target="_blank" rel="noreferrer">
                  LinkedIn
                </a>
                <a href="mailto:siewwwin@gmail.com">Email</a>
              </div>
            </div>
            <div className="foot-line">
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
            </div>
            {NETWORK_ID === "testnet" ? <p>Test network. Money here is test NEAR with no real value.</p> : null}
          </div>
        </footer>
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
      <SignIn open={signingIn} onDone={done} />
      {account ? <AccountMenu open={menu} onClose={() => setMenu(false)} account={account} kind={kind} /> : null}
    </Ctx.Provider>
  );
}
