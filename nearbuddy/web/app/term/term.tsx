"use client";
// "Fool the AI" as one terminal screen: a status bar, five numbered panes (1 hardest to fool, 2 live duel or the
// replay of answered attacks, 3 tail of attacks, 4 inject, 5 saboteurs), a vim-style status line and a command line.
// Everything is clickable, and every click types the command it stands for, so a newcomer learns the keyboard path by
// using the mouse. The live duel and the inject box come first: something resolves within a minute (a duel's close,
// or the next replayed verdict) and a headline can be drafted for free at once. Data: /api/arena (15 s), /api/board
// (dataset snapshot), /api/spot (2 s while visible), /api/flips (60 s), /api/duel for a pinned duel. Wallet: NEAR
// Connect (lib/wallet), loaded on first use.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type Flip, replay, type Saboteur } from "../api/flips";
import type { Arm } from "../lib/abi/arena";
import { COMMANDS, complete, injectLine, parse, type Target } from "../lib/cmd";
import { adapterFor, claimable, claimCall, type Direction, MAX_HEADLINE, Offline, utf8Bytes } from "../lib/inject";
import * as wallet from "../lib/wallet";
import { agentHref, countdown, duelHref, getJson, NETWORK_ID, near, short, txHref, ZERO } from "../tui";
import { Box, type Cell, col, FlashCtx, Line, Note, Slot, wrap } from "./box";
import {
  attacksOf,
  type Board,
  changed,
  type Duel,
  type DuelRec,
  type FeedItem,
  feed,
  fields,
  livePnl,
  type Mine,
  pickLive,
  type Snap,
  shortModel,
  textsOf,
  VERDICT_OF,
} from "./model";

type Pane = 1 | 2 | 3 | 4 | 5;
type Spot = { price: string; at: number };
/** GET /api/flips: answered attacks for the replay, and the saboteurs board. */
type Flips = { at: number; flips: Flip[]; saboteurs: Saboteur[]; scanned: { from: number; to: number } | null };
const PANES: [Pane, string][] = [
  [1, "board"],
  [2, "duel"],
  [3, "tail"],
  [4, "inject"],
  [5, "ranks"],
];
/** One replayed attack every CARD_MS: its headline, then the model's answer, then the verdict and the payout. */
const CARD_MS = 8000;
/** The six words a stranger needs; the full rules are in /llms.txt. */
const GLOSSARY: [string, string][] = [
  ["sealed", "a model's call is hidden until it reveals it"],
  ["flipped", "its next call moved to the lie's side: fooled"],
  ["held", "it did not move: your stake goes to its bond"],
  ["bond", "the NEAR a model stakes; a lost duel slashes it"],
  ["pot", "what the duel pays its winner"],
  ["arm", "how your headline arrives: cue (as written) or clean (BREAKING and named sources removed)"],
];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const upper = (s: string | null | undefined) => (s ? s.toUpperCase() : "-");
const VERDICT: Record<FeedItem["verdict"], [string, string]> = {
  fooled: ["FOOLED", "loss"],
  held: ["HELD", "win"],
  untested: ["not counted", "dim"],
  waiting: ["waiting", "open"],
  answered: ["answered", "hi"],
  expired: ["expired", "dim"],
};
const opposite = (s: Direction | null | undefined): Direction => (s === "Long" ? "Short" : "Long");
const ARM_TITLE: Record<Arm, string> = {
  Cue: "delivered as written",
  Clean: "delivered with its credibility cues (BREAKING, named sources) removed",
  Placebo: "a neutral control headline",
};

/** Columns of monospace text that fit the terminal's width, measured from a probe span. */
function useCols(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(160);
  useEffect(() => {
    const el = ref.current;
    const probe = el?.querySelector<HTMLElement>(".probe");
    if (!el || !probe) return;
    const ro = new ResizeObserver(() => {
      const cw = probe.getBoundingClientRect().width / 10;
      if (cw > 0) setCols(Math.floor(el.clientWidth / cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols];
}

const bpsText = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)} bps`;

export default function Term() {
  const router = useRouter();
  const [rootRef, cols] = useCols();
  const [snap, setSnap] = useState<Snap | null>(null);
  const [snapErr, setSnapErr] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [flips, setFlips] = useState<Flips | null>(null);
  /** Replay cards skipped by hand ([next]); the replay starts at the newest card when the page opens (t0). */
  const [skip, setSkip] = useState(0);
  const [t0, setT0] = useState(0);
  /** prefers-reduced-motion: a replayed card shows whole instead of in three beats. */
  const [still, setStill] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [rec, setRec] = useState<DuelRec | null>(null);
  const [now, setNow] = useState(0);
  const [pane, setPane] = useState<Pane>(2);
  const [sel, setSel] = useState<Record<Pane, number>>({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const [help, setHelp] = useState(false);
  const [line, setLine] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [hist, setHist] = useState<string[]>([]);
  const [histAt, setHistAt] = useState(-1);
  const [msg, setMsg] = useState<{ t: string; c?: string } | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>("B");
  /** The side the lie pushes (deploy 17); null: against the target's last call. */
  const [kind, setKind] = useState<Direction | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [share, setShare] = useState<string | null>(null);
  const [flash, setFlash] = useState<ReadonlyMap<string, number>>(new Map());
  const [mode, setMode] = useState<"NORMAL" | "COMMAND" | "INSERT">("NORMAL");
  const cmdRef = useRef<HTMLInputElement | null>(null);
  const sending = useRef(false);
  const helpRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const prevFields = useRef<Record<string, string>>({});
  const prevFeed = useRef<Set<string> | null>(null);

  // polling: the arena snapshot, the spot price (only while the tab is visible), the board once, the answered attacks,
  // the pinned duel; a 1 s clock for countdowns
  useEffect(() => {
    let alive = true;
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const arena = () =>
      getJson<Snap>("/api/arena")
        .then((j) => {
          if (!alive) return;
          setSnap(j);
          setTexts((t) => ({ ...t, ...textsOf(j) })); // keep a headline after the solver stops listing it
          setSnapErr(null);
        })
        .catch((e) => alive && setSnapErr(e instanceof Error ? e.message : String(e)));
    const price = () =>
      document.visibilityState === "hidden"
        ? undefined
        : getJson<Spot>("/api/spot")
            .then((j) => alive && setSpot(j))
            .catch(() => {});
    const answered = () =>
      getJson<Flips>("/api/flips")
        .then((j) => alive && setFlips(j))
        .catch(() => {}); // the replay falls back to the dataset's attacks from /api/board
    arena();
    price();
    answered();
    getJson<Board>("/api/board")
      .then((j) => alive && setBoard(j))
      .catch(() => {});
    setNow(Date.now());
    setT0(Date.now());
    const t1 = setInterval(arena, 15_000); // the route caches 20 s
    const t2 = setInterval(price, 2000); // the route caches 2 s: one trade-price read per 2 s for every tab
    const t3 = setInterval(() => setNow(Date.now()), 1000);
    const t4 = setInterval(answered, 60_000);
    return () => {
      alive = false;
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
    };
  }, []);
  useEffect(() => {
    if (!pinned) return setRec(null);
    let alive = true;
    const go = () =>
      getJson<DuelRec>(`/api/duel?id=${encodeURIComponent(pinned)}`)
        .then((j) => alive && setRec(j))
        .catch((e) => alive && setMsg({ t: `duel #${pinned}: ${e instanceof Error ? e.message : e}`, c: "bad" }));
    go();
    const t = setInterval(go, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pinned]);
  // the wallet: the account a previous visit connected, and sign-ins/outs from the wallet's own UI
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    wallet.account().then((a) => alive && setAccount(a));
    wallet
      .onChange((a) => alive && setAccount(a))
      .then((f) => {
        off = f;
        if (!alive) f();
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const duel: Duel | null = pinned ? (rec?.duel ?? null) : pickLive(snap?.duels, now);
  const agent = (pk: string) => snap?.leaderboard.find((a) => a.pk === pk) ?? (rec?.a?.pk === pk ? rec.a : rec?.b);
  const modelOf = (pk: string) => {
    const id = agent(pk)?.model_id;
    return id ? shortModel(id) : short(pk, 8);
  };
  // no duel live or closing: pane 2 replays answered attacks (chain first, the dataset's until /api/flips answers)
  const replaying = !pinned && !duel;
  const cards: Flip[] = flips?.flips.length ? flips.flips : replay([], board?.recent ?? [], () => null);
  const since = Math.max(0, now - t0);
  const cardAt = Math.floor(since / CARD_MS) + skip;
  const card = cards.length ? (cards[cardAt % cards.length] ?? null) : null;
  const beat = still ? 4 : Math.floor((since % CARD_MS) / 1000); // 0-1 headline, 2-3 + answer, 4+ + verdict
  const closeMs = duel ? Number(BigInt(duel.close_at) / 1_000_000n) : 0;
  const open = !!duel && !duel.resolved && closeMs > now;
  const left = duel && open ? countdown(duel.close_at, now) : null;
  const items = feed(snap, board, mine, texts);
  const models = board?.models ?? [];
  // the inject path by contract feature: deploy 17 puts the headline on chain and needs no solver
  const adapter = adapterFor(snap?.config);
  const v2 = adapter.needsKind;
  const terms = snap?.config.chaos; // deploy 17's fee and flip share, as the help states them
  const solverDown = !v2 && (offline || snap?.solver === null);
  const chainOf = (s: Snap, d: Duel | null) => ({
    contract: s.contract,
    min_chaos_deposit: s.config.min_chaos_deposit,
    chaos_fee: d?.chaos_fee ?? null,
  });
  const chain = snap ? chainOf(snap, duel) : null;
  const price = chain ? adapter.price(chain) : null;
  // what the first attack in the next duel costs: chaos_fee of a duel with no attacks yet is the base (deploy 17)
  const nextPrice = snap ? (snap.config.chaos?.base ?? snap.config.min_chaos_deposit) : null;
  const shownPrice = open ? price : nextPrice;
  const lastSide = (t: Target) => (t === "A" ? duel?.last_intent_a : duel?.last_intent_b)?.side;
  const push = kind ?? opposite(lastSide(target)); // a lie on the side it already sits on cannot flip it
  const lineFor = (t: Target, k: Direction | null) => (duel ? injectLine(duel.id, t, text, v2 ? k : null) : "");
  const owed = duel?.resolved ? claimable(duel.chaos, account) : 0n;
  const refusal = text ? adapter.check(text) : null;

  // diff-based refresh: the cells whose value moved since the last poll flash once; new feed rows flash too
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per poll result, not per 1 s clock tick
  useEffect(() => {
    const f = fields(snap, board, duel);
    const ch = changed(prevFields.current, f);
    prevFields.current = f;
    const keys = new Set(items.map((i) => i.key));
    const fresh = prevFeed.current ? [...keys].filter((k) => !prevFeed.current?.has(k)) : [];
    if (board && snap) prevFeed.current = keys; // both sources in: from here on, a new key is a new attack
    if (ch.length || fresh.length)
      setFlash((m) => {
        const n = new Map(m);
        const at = Date.now();
        for (const k of ch) n.set(k, at);
        for (const k of fresh) n.set(`feed:${k}`, at);
        return n;
      });
  }, [snap, board, rec, mine]);

  const say = (t: string, c?: string) => setMsg(c ? { t, c } : { t });
  const focusPane = (p: Pane) => {
    setPane(p);
    document.getElementById(`pane-${p}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const known = {
    duels: [...new Set([...(snap?.duels ?? []).flatMap((d) => (d ? [d.id] : [])), ...items.map((i) => i.duel)])],
    agents: [
      ...new Set([
        ...models.map((m) => shortModel(m.model)),
        ...(snap?.leaderboard ?? []).filter((a) => a.tee).map((a) => shortModel(a.model_id)),
      ]),
    ],
  };
  /** An agent key for a model name or key: the one in the shown duel first, then the board's order. */
  const findAgent = (who: string) => {
    const lb = snap?.leaderboard ?? [];
    const w = who.toLowerCase();
    const hits = lb.filter(
      (a) => a.pk === who || a.model_id.toLowerCase() === w || shortModel(a.model_id).toLowerCase().startsWith(w),
    );
    return hits.find((a) => a.pk === duel?.a || a.pk === duel?.b) ?? hits[0] ?? null;
  };

  // one wallet call at a time: a ref, so a double click lands on the guard before the busy re-render does
  async function once(f: () => Promise<void>) {
    if (sending.current) return say("one at a time: finish the one in progress first", "warn");
    sending.current = true;
    try {
      await f();
    } finally {
      sending.current = false;
      setBusy(null);
    }
  }
  /** A duel by id: the snapshot's, the pinned one, else read once. */
  async function findDuel(id: string): Promise<Duel | null> {
    const d = snap?.duels.find((x) => x?.id === id) ?? (rec?.duel?.id === id ? rec.duel : null);
    return (
      d ??
      getJson<DuelRec>(`/api/duel?id=${id}`)
        .then((r) => r.duel)
        .catch(() => null)
    );
  }
  async function injectOnce(id: string, side: Target, headline: string, dir: Direction | null) {
    if (!snap) return say("still reading the arena; try again in a moment", "warn");
    const d = await findDuel(id);
    if (!d) return say(`no duel #${id} on this contract`, "bad");
    if (d.resolved || Number(BigInt(d.close_at) / 1_000_000n) <= Date.now())
      return say(`duel #${id} is closed: a headline only lands while its duel is open`, "warn");
    const bad = adapter.check(headline); // the contract's own rules, so a refusal shows before any signing
    if (bad) return say(`the contract would refuse this: ${bad} · nothing was signed`, "warn");
    if (adapter.needsKind && !dir)
      return say(`say which way the lie pushes: inject ${id} ${side} short "${headline.slice(0, 20)}…"`, "warn");
    // /api/arena reads the same solver: when it is unreachable there, say so before asking for a wallet
    if (!adapter.needsKind && snap.solver === null)
      return say("solver offline: attacks are paused, nothing was sent or signed", "bad");
    if (!account) return say("connect a NEAR testnet wallet first: type connect, or press the connect button", "warn");
    const target = side === "A" ? d.a : d.b;
    setBusy(adapter.needsKind ? "reading the price" : "handing the headline to the solver");
    let call: Awaited<ReturnType<typeof adapter.prepare>>;
    try {
      call = await adapter.prepare({ duel_id: id, target, text: headline, kind: dir }, chainOf(snap, d));
    } catch (e) {
      if (e instanceof Offline) {
        setOffline(true);
        return say("solver offline: your headline was not sent and nothing was signed", "bad");
      }
      return say(`refused: ${e instanceof Error ? e.message : e}`, "bad");
    }
    setBusy(`sign in your wallet: ${near(call.deposit)} NEAR to ${call.receiverId}`);
    const before = (side === "A" ? d.last_intent_a : d.last_intent_b)?.nonce ?? null;
    try {
      const tx = await wallet.send(call); // throws when the wallet declines or the contract refuses
      const hash = typeof call.args.payload_hash === "string" ? call.args.payload_hash : null;
      setMine((m) => [...m, { tx, duel: id, target, text: headline, hash, before, at: Date.now() }]);
      // deploy 17's card reads the headline from chain; deploy 16's needs it in the link
      setShare(`${location.origin}/i/${tx}${hash ? `?t=${encodeURIComponent(headline)}` : ""}`);
      setText("");
      say(`planted in duel #${id}, side ${side}: tx ${short(tx, 10)} · type copy for the share link`, "ok");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // chaos_fee rises with every paid attack: someone else's landed first
      say(
        m.includes("chaos deposit too small") ? `${m} · the price just rose; the pane shows the new one shortly` : m,
        "bad",
      );
    }
  }
  async function claimOnce(id: string) {
    if (!snap) return say("still reading the arena; try again in a moment", "warn");
    if (!account) return say("connect the wallet that planted the headlines first: type connect", "warn");
    const d = await findDuel(id);
    if (!d) return say(`no duel #${id} on this contract`, "bad");
    if (!d.chaos) return say(`duel #${id} has no on-chain chaos records to claim from (deploy 17 on)`, "warn");
    if (!d.resolved) return say(`duel #${id} is still running: stakes settle when it finishes`, "warn");
    const due = claimable(d.chaos, account);
    if (!due) return say(`nothing to claim for ${account} in duel #${id}`, "warn");
    const call = claimCall(snap.contract, id);
    setBusy(`sign in your wallet: claim ${near(due.toString())} NEAR from duel #${id}`);
    try {
      const tx = await wallet.send(call);
      say(`claimed ${near(due.toString())} NEAR from duel #${id}: tx ${short(tx, 10)}`, "ok");
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  /** Types `cmd` into the prompt (so a click shows its command), keeps it in history and runs it. */
  async function run(cmd: string) {
    const c = parse(cmd);
    setLine(cmd);
    setOptions([]);
    setHistAt(-1);
    if (cmd.trim()) setHist((h) => [...h.filter((x) => x !== cmd), cmd].slice(-50));
    switch (c.k) {
      case "error":
        return say(c.msg, "bad");
      case "watch":
        setPinned(null);
        focusPane(2);
        return say("following the live duel");
      case "duel":
        setPinned(c.id);
        focusPane(2);
        return say(`showing duel #${c.id} · type watch to follow the live one again`);
      case "agent": {
        const a = findAgent(c.who);
        if (!a) return say(`no agent matches "${c.who}"`, "bad");
        say(`opening ${shortModel(a.model_id)}`);
        return router.push(agentHref(a.pk));
      }
      case "verify":
        say(`opening the proofs of duel #${c.duel}`);
        return router.push(`${duelHref(c.duel)}`);
      case "inject":
        setTarget(c.side);
        if (c.kind) setKind(c.kind);
        setText(c.text);
        focusPane(4);
        return once(() => injectOnce(c.duel, c.side, c.text, c.kind));
      case "claim":
        return once(() => claimOnce(c.duel));
      case "connect":
        if (account) return say(`connected as ${account} · type disconnect to switch`);
        try {
          setBusy("waiting for your wallet");
          const a = await wallet.signIn();
          setAccount(a);
          return say(a ? `connected as ${a}` : "no account selected", a ? "ok" : "warn");
        } catch (e) {
          return say(`wallet: ${e instanceof Error ? e.message : e}`, "bad");
        } finally {
          setBusy(null);
        }
      case "disconnect":
        await wallet.signOut().catch(() => {});
        setAccount(null);
        return say("disconnected");
      case "help":
        setHelp(true);
        return;
      case "copy": {
        // the share step needs the attack's card: before an attack there is nothing of yours to share
        if (!share) return say("plant a headline first: copy shares its card", "warn");
        const link = share;
        try {
          await navigator.clipboard.writeText(link);
          return say(`copied ${link}`, "ok");
        } catch {
          return say(`copy this: ${link}`);
        }
      }
    }
  }

  // rows per pane, for j/k and Enter
  const duelActions = duel ? (["A", "B"] as Target[]) : [];
  const feedShown = items.slice(0, cols < 122 ? 5 : 7);
  const rowsOf: Record<Pane, number> = {
    1: models.length,
    2: duelActions.length,
    3: feedShown.length,
    4: v2 ? 3 : 2,
    5: 0,
  };
  const pickTarget = (t: Target) => {
    setTarget(t);
    setKind(null); // the default push follows the new target's call
    setLine(lineFor(t, opposite(lastSide(t))));
  };
  const pickKind = (k: Direction) => {
    setKind(k);
    setLine(lineFor(target, k));
  };
  const activate = (p: Pane, i: number) => {
    if (p === 1 && models[i]) return run(`agent ${shortModel(models[i].model)}`);
    const side = duelActions[i];
    if (p === 2 && duel && side) {
      // a closed duel takes no headline: its side rows open that model's record instead
      if (!open) return run(`agent ${modelOf(side === "A" ? duel.a : duel.b)}`);
      pickTarget(side);
      focusPane(4);
      return textRef.current?.focus();
    }
    if (p === 3 && feedShown[i]) return run(`duel ${feedShown[i].duel}`);
    if (p === 4 && i === 0) return pickTarget(target === "A" ? "B" : "A");
    if (p === 4 && v2 && i === 1) return pickKind(opposite(push));
    if (p === 4) return textRef.current?.focus();
  };

  // keys outside text fields: 1-4 panes, j/k rows, Enter, i inject, v verify, ? help, : or Cmd-K command line
  const keyState = useRef({ pane, sel, rowsOf, help, duel, activate, run, focusPane });
  useEffect(() => {
    keyState.current = { pane, sel, rowsOf, help, duel, activate, run, focusPane };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        cmdRef.current?.focus();
        return;
      }
      if (e.key === "Escape" && k.help) return setHelp(false); // from anywhere, the command line included
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") return setHelp(!k.help);
      if (k.help) return e.key === "q" && setHelp(false);
      if (e.key === ":" || e.key === "/") {
        e.preventDefault();
        cmdRef.current?.focus();
        return;
      }
      if (e.key >= "1" && e.key <= "5") return k.focusPane(Number(e.key) as Pane);
      const n = k.rowsOf[k.pane];
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        return setSel((s) => ({ ...s, [k.pane]: n ? Math.min(n - 1, s[k.pane] + 1) : 0 }));
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        return setSel((s) => ({ ...s, [k.pane]: Math.max(0, s[k.pane] - 1) }));
      }
      if (e.key === "Enter" && !(el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement)) {
        e.preventDefault();
        return k.activate(k.pane, k.sel[k.pane]);
      }
      if (e.key === "i") {
        e.preventDefault();
        k.focusPane(4);
        return textRef.current?.focus();
      }
      if (e.key === "v" && k.duel) return k.run(`verify ${k.duel.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // layout: two columns of boxes when 2 x 60 columns fit, else one; every box exactly P characters wide
  const two = cols >= 122;
  const P = Math.max(36, Math.min(two ? Math.floor((cols - 2) / 2) : cols, 100));
  const W = P - 4; // text width inside a box

  // the help dialog takes focus when it opens, so a keyboard or screen-reader user lands inside it
  useEffect(() => {
    if (help) helpRef.current?.focus();
  }, [help]);

  // ---- pane 1: hardest to fool
  const nameW = Math.min(30, W - 17);
  const tested = models.reduce((s, m) => s + m.tested, 0);
  const pane1 = (
    <Box n={1} title="hardest to fool" extra="fooled / tested" w={P} on={pane === 1} id="pane-1">
      <Line
        w={P}
        cells={[
          {
            t: `   ${"model".padEnd(nameW)} ${"fooled".padStart(6)} ${"rate".padStart(4)}`,
            c: "dim",
          },
        ]}
      />
      {models.map((m, i) => {
        const name = shortModel(m.model);
        return (
          <Line
            key={m.model}
            w={P}
            sel={pane === 1 && sel[1] === i}
            onClick={() => run(`agent ${name}`)}
            label={`${name}: fooled ${m.fooled} of ${m.tested} tested attacks, ${pct(m.tested ? m.fooled / m.tested : 0)}. Open its record.`}
            cells={[
              { t: `${i + 1}  `, c: "num" },
              { t: col(name, nameW), c: "hi" },
              " ",
              { t: `${m.fooled}/${m.tested}`.padStart(6), k: `board:${m.model}` },
              " ",
              {
                t: pct(m.tested ? m.fooled / m.tested : 0).padStart(4),
                c: m.fooled / m.tested > 0.5 ? "loss" : "win",
              },
            ]}
          />
        );
      })}
      {!models.length ? <Line w={P} cells={[{ t: board ? "no attacks scored yet" : "loading", c: "dim" }]} /> : null}
      <Line w={P} cells={[""]} />
      {board ? <Note w={P} text={`fooled = flipped to the lie's side · ${tested} tested attacks`} /> : null}
    </Box>
  );

  // ---- pane 2: the live (or pinned) duel
  const openPx = duel?.open_price ? Number(duel.open_price) / 1e8 : null;
  const closePx = duel?.outcome?.close_price ? Number(duel.outcome.close_price) / 1e8 : null;
  const spotPx = duel?.resolved ? closePx : spot ? Number(spot.price) : null;
  const move = openPx && spotPx ? ((spotPx / openPx - 1) * 1e4).toFixed(1) : null;
  const attacks = duel ? attacksOf(duel) : 0;
  const callCells = (t: Target): Cell[] => {
    if (!duel) return [];
    const pk = t === "A" ? duel.a : duel.b;
    const it = t === "A" ? duel.last_intent_a : duel.last_intent_b;
    const proven = !!it?.proof_hash && it.proof_hash !== ZERO;
    // open: the call's profit at the live price; resolved: the contract's own score
    const pnl = duel.resolved
      ? ((t === "A" ? duel.outcome?.pnl_a : duel.outcome?.pnl_b) ?? null)
      : open
        ? livePnl(it, openPx, spotPx)
        : null;
    return [
      { t: `${t}  `, c: "num" },
      { t: col(modelOf(pk), Math.max(10, Math.min(24, W - 34))), c: "hi" },
      " ",
      it
        ? {
            t: `${upper(it.side).padEnd(5)} ${String(it.size_bps / 100).padStart(3)}%`,
            c: "hi",
            k: `duel:${duel.id}:${t.toLowerCase()}`,
          }
        : {
            t: snap?.config.commit_reveal ? "sealed until its reveal" : "no call yet",
            c: "dim",
            k: `duel:${duel.id}:${t.toLowerCase()}`,
          },
      "  ",
      pnl != null
        ? {
            t: bpsText(pnl).padStart(11),
            c: pnl > 0 ? "win" : pnl < 0 ? "loss" : "tie",
            title: duel.resolved ? "scored by the contract on the oracle's close" : "live, display only",
          }
        : "",
      pnl != null ? "  " : "",
      it ? (proven ? { t: "enclave-signed", c: "ok" } : { t: "no proof", c: "unv" }) : "",
    ];
  };
  // deploy 17: the duel's newest chaos records, read from chain (headline, arm, outcome)
  const records = (duel?.chaos ?? [])
    .map((c, i) => ({ c, i }))
    .reverse()
    .slice(0, cols < 122 ? 3 : 4);
  const state = !duel
    ? ""
    : duel.resolved
      ? duel.outcome
        ? duel.outcome.winner
          ? `resolved · ${duel.outcome.winner === duel.a ? "A" : "B"} won`
          : "resolved · tie"
        : "resolved"
      : left
        ? `closes in ${left}`
        : "closed · waiting for the oracle";
  /** One answered attack in three beats: the headline, then the model's answer, then the verdict and what it paid. */
  const replayCard = (f: Flip) => {
    const [word, wc] = VERDICT[f.verdict];
    const lie = wrap(`"${f.headline}"`, W - 7).slice(0, 3);
    const answer = f.reply
      ? wrap(`"${f.reply}"`, W - 7).slice(0, 2)
      : [f.after ? `its next call: ${upper(f.after)}` : "its next call"];
    const paid = f.stake && f.payout ? `${near(f.stake)} NEAR in → ${near(f.payout)} NEAR out` : null;
    return (
      <>
        <Line
          w={P}
          cells={[
            { t: `#${f.duel} → ${shortModel(f.model)}`, c: "hi" },
            f.pushed ? { t: ` · pushes ${upper(f.pushed)}`, c: "dim", title: "the side the lie pushes" } : "",
            f.arm ? { t: ` · ${f.arm.toLowerCase()}`, c: "dim", title: ARM_TITLE[f.arm] } : "",
          ]}
        />
        {lie.map((l, i) => (
          <Line
            key={`lie:${l}`}
            w={P}
            cells={[
              { t: i ? "       " : "lie    ", c: "dim" },
              { t: l, c: "warn" },
            ]}
          />
        ))}
        {(beat >= 2 ? answer : [""]).map((l, i) => (
          <Line
            key={`ans:${l}`}
            w={P}
            cells={[
              { t: i || beat < 2 ? "       " : "reply  ", c: "dim" },
              { t: l, c: beat >= 2 ? "hi" : "dim" },
            ]}
          />
        ))}
        <Line
          w={P}
          cells={
            beat >= 4
              ? [{ t: word === "FOOLED" ? "FLIPPED" : word, c: wc }, paid ? { t: `  ${paid}`, c: "ok" } : ""]
              : [{ t: beat >= 2 ? "verdict …" : "", c: "dim" }]
          }
        />
        <Line w={P} cells={[""]} />
        <Line
          w={P}
          cells={[
            {
              t: `[watch #${f.duel}]`,
              onClick: () => run(`duel ${f.duel}`),
              label: `watch duel ${f.duel}: ${shortModel(f.model)}, ${word.toLowerCase()}`,
            },
            " ",
            { t: "[next]", onClick: () => setSkip((x) => x + 1), label: "replay the next answered attack" },
            { t: `  ${(cardAt % cards.length) + 1} of ${cards.length}`, c: "dim" },
          ]}
        />
      </>
    );
  };
  const pane2 = (
    <Box
      n={2}
      title={pinned ? "duel" : duel ? "live duel" : "replay"}
      extra={
        duel
          ? `#${duel.id} ${left ?? (duel.resolved ? "resolved" : "closed")}`
          : pinned
            ? `#${pinned}`
            : card
              ? `#${card.duel} · ${card.stake ? "on chain" : "dataset"}`
              : ""
      }
      w={P}
      on={pane === 2}
      id="pane-2"
    >
      {duel ? (
        <>
          <Line
            w={P}
            cells={[
              { t: duel.symbol === "wrap.near" ? "NEAR/USD" : duel.symbol, c: "hi" },
              { t: "  open ", c: "dim" },
              openPx ? openPx.toFixed(4) : { t: "oracle pending", c: "dim" },
              { t: duel.resolved ? "  close " : "  now ", c: "dim" },
              spotPx ? spotPx.toFixed(4) : { t: duel.resolved ? "oracle pending" : "reading", c: "dim" },
              move ? { t: `  ${Number(move) >= 0 ? "+" : ""}${move} bps`, c: Number(move) >= 0 ? "win" : "loss" } : "",
            ]}
          />
          {open ? <Note w={P} text="live, display only; settlement uses the oracle" /> : null}
          <Line w={P} cells={[""]} />
          {duelActions.map((t, i) => (
            <Line
              key={t}
              w={P}
              sel={pane === 2 && sel[2] === i}
              onClick={() => activate(2, i)}
              label={`${open ? `target side ${t} with a headline` : `open side ${t}'s record`}: ${callCells(t)
                .map((c) => (typeof c === "string" ? c : c.t))
                .join("")
                .replace(/\s+/g, " ")
                .trim()}`}
              cells={callCells(t)}
            />
          ))}
          <Line w={P} cells={[""]} />
          <Line
            w={P}
            cells={[
              { t: "pot ", c: "dim" },
              { t: `${near(duel.pool)} NEAR`, k: `duel:${duel.id}:pot` },
              { t: "  attacks ", c: "dim" },
              { t: String(attacks), k: `duel:${duel.id}:attacks` },
              ...(open
                ? ([
                    { t: "  next attack ", c: "dim" },
                    { t: price ? `${near(price)} NEAR` : "reading", c: price ? "warn" : "dim", k: "price" },
                  ] as Cell[])
                : []),
            ]}
          />
          <Line w={P} cells={[{ t: state, c: open ? "open" : "dim", k: `duel:${duel.id}:state` }]} />
          {records.length ? <Line w={P} cells={[""]} /> : null}
          {records.map(({ c, i }) => {
            const [word, wc] = VERDICT[VERDICT_OF[c.outcome]];
            const decided = c.decided_by ? ` by call #${c.decided_by}` : "";
            return (
              <Line
                key={`${duel.id}:${i}`}
                w={P}
                cells={[
                  { t: `#${String(i).padEnd(3)}`, c: "num" },
                  { t: c.target === duel.a ? "A " : "B ", c: "hi" },
                  { t: upper(c.kind).padEnd(8), c: "dim", title: "the side the lie pushes" },
                  { t: c.arm.toLowerCase().padEnd(8), c: "dim", title: ARM_TITLE[c.arm] },
                  {
                    t: word.padEnd(12),
                    c: wc,
                    k: `duel:${duel.id}:chaos:${i}`,
                    title: `${c.outcome}${decided}${c.injector === account ? " · yours" : ""}`,
                  },
                  { t: `"${c.headline}"`, c: "warn", title: c.headline },
                ]}
              />
            );
          })}
          {(duel.chaos?.length ?? 0) > records.length ? (
            <Line
              w={P}
              cells={[{ t: `+${(duel.chaos?.length ?? 0) - records.length} more in the tail (pane 3)`, c: "dim" }]}
            />
          ) : null}
          <Line
            w={P}
            cells={[
              ...(open
                ? ([
                    { t: "[inject A]", onClick: () => activate(2, 0) },
                    " ",
                    { t: "[inject B]", onClick: () => activate(2, 1) },
                    " ",
                  ] as Cell[])
                : []),
              // a duel nobody attacked has no verdict to check: no dead end for a stranger
              attacks ? { t: "[verify]", onClick: () => run(`verify ${duel.id}`) } : "",
              attacks ? " " : "",
              owed
                ? {
                    t: `[claim ${near(owed.toString())} NEAR]`,
                    c: "ok",
                    onClick: () => run(`claim ${duel.id}`),
                    label: `claim ${near(owed.toString())} NEAR your headlines earned in duel ${duel.id}`,
                  }
                : "",
              owed ? " " : "",
              pinned ? { t: "[watch live]", onClick: () => run("watch") } : "",
            ]}
          />
        </>
      ) : pinned ? (
        <Line w={P} cells={[{ t: `reading duel #${pinned}`, c: "dim" }]} />
      ) : card ? (
        replayCard(card)
      ) : (
        <Line
          w={P}
          cells={[{ t: snapErr ? `arena unreadable: ${snapErr}` : "reading the arena", c: snapErr ? "bad" : "dim" }]}
        />
      )}
      {duel && !open && !pinned ? (
        <Note w={P} text="scoring at the oracle's close · this pane switches to the next duel by itself" />
      ) : null}
      {replaying && card ? (
        <Note
          w={P}
          text={
            snap
              ? "replaying answered attacks until the next duel opens · this pane switches to it by itself"
              : "replaying answered attacks while the live arena loads"
          }
        />
      ) : null}
    </Box>
  );

  // ---- pane 3: tail of attacks
  const pane3 = (
    <Box n={3} title="tail" extra="attack → reply → verdict" w={P} on={pane === 3} id="pane-3">
      {feedShown.map((f, i) => {
        const [word, wc] = VERDICT[f.verdict];
        const head = `#${f.duel} → ${f.model}${f.mine ? " (you)" : ""}`;
        return (
          <div key={f.key} className={pane === 3 && sel[3] === i ? "item sel" : "item"}>
            <Line
              w={P}
              onClick={() => run(`duel ${f.duel}`)}
              label={`duel ${f.duel}, ${f.model}: ${word}. Show this duel.`}
              cells={[
                { t: head.slice(0, W - 13).padEnd(W - 12), c: "hi", k: `feed:${f.key}` },
                { t: word.padStart(12), c: wc },
              ]}
            />
            <Line
              w={P}
              cells={[
                { t: "  lie   ", c: "dim" },
                f.pushed ? { t: `${upper(f.pushed)} `, c: "dim", title: "the side the lie pushes" } : "",
                f.arm ? { t: `${f.arm.toLowerCase()} `, c: "dim", title: ARM_TITLE[f.arm] } : "",
                f.lie
                  ? { t: `"${f.lie}"`, c: "warn", title: f.lie }
                  : { t: f.hash ? `sha256 ${short(f.hash, 12)} (text held by the solver)` : "-", c: "dim" },
              ]}
            />
            <Line
              w={P}
              cells={[
                { t: "  reply ", c: "dim" },
                f.after ? { t: `${upper(f.after)} `, c: f.verdict === "fooled" ? "loss" : "hi" } : "",
                f.reply
                  ? { t: `"${f.reply}"`, title: f.reply }
                  : {
                      t: f.decided_by
                        ? `decided by its proved call #${f.decided_by}`
                        : f.verdict === "waiting"
                          ? "next proved call pending"
                          : f.verdict === "answered"
                            ? "its first call after your headline"
                            : f.verdict === "expired"
                              ? "the duel ended before a proved call"
                              : "",
                      c: "dim",
                    },
                f.tx ? "  " : "",
                f.tx ? { t: `tx ${short(f.tx, 6)}`, href: txHref(f.tx), title: f.tx, c: "dim" } : "",
              ]}
            />
          </div>
        );
      })}
      {!feedShown.length ? <Line w={P} cells={[{ t: board ? "no attacks yet" : "loading", c: "dim" }]} /> : null}
    </Box>
  );

  // ---- pane 4: inject
  const canSend = open && !solverDown && !busy && !!text.trim() && !refusal;
  const tgtPk = duel ? (target === "A" ? duel.a : duel.b) : null;
  const bytes = utf8Bytes(text);
  const pane4 = (
    <Box n={4} title="inject" extra="plant one fake headline" w={P} on={pane === 4} id="pane-4">
      <Line
        w={P}
        sel={pane === 4 && sel[4] === 0}
        cells={[
          { t: "target ", c: "dim" },
          ...(duel && open
            ? (["A", "B"] as Target[]).flatMap((t): Cell[] => [
                {
                  t: `[${target === t ? "x" : " "}] ${t} ${col(modelOf(t === "A" ? duel.a : duel.b), Math.max(6, Math.floor((W - 20) / 2))).trimEnd()}`,
                  c: target === t ? "hi" : "dim",
                  onClick: () => pickTarget(t),
                  label: `target side ${t}, ${modelOf(t === "A" ? duel.a : duel.b)}${target === t ? ", selected" : ""}`,
                },
                "  ",
              ])
            : [{ t: "A or B of the next duel", c: "dim" }]),
        ]}
      />
      {v2 ? (
        <Line
          w={P}
          sel={pane === 4 && sel[4] === 1}
          cells={[
            { t: "push   ", c: "dim" },
            ...(["Long", "Short"] as Direction[]).flatMap((k): Cell[] => [
              {
                t: `[${push === k ? "x" : " "}] ${k.toLowerCase()}`,
                c: push === k ? "hi" : "dim",
                onClick: () => pickKind(k),
                label: `the lie pushes ${k.toLowerCase()}${push === k ? ", selected" : ""}`,
              },
              "  ",
            ]),
            lastSide(target)
              ? { t: `its call now: ${upper(lastSide(target))}`, c: push === lastSide(target) ? "warn" : "dim" }
              : "",
          ]}
        />
      ) : null}
      <Slot rows={3}>
        <textarea
          ref={textRef}
          className="headline"
          aria-label="your fake headline"
          aria-invalid={!!refusal}
          placeholder="BREAKING: ..."
          maxLength={MAX_HEADLINE}
          rows={3}
          value={text}
          style={{ width: `${W}ch` }}
          onFocus={() => {
            setMode("INSERT");
            setPane(4);
          }}
          onBlur={() => setMode("NORMAL")}
          onChange={(e) => {
            setText(e.target.value);
            if (duel) setLine(injectLine(duel.id, target, e.target.value, v2 ? push : null));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && duel) run(lineFor(target, push));
          }}
        />
      </Slot>
      <Line
        w={P}
        cells={[
          {
            t: `${bytes}/${MAX_HEADLINE}${v2 ? " bytes" : ""}  `,
            c: bytes > MAX_HEADLINE ? "bad" : "dim",
          },
          { t: open ? "costs " : "first attack ", c: "dim" },
          { t: shownPrice ? `${near(shownPrice)} NEAR` : "reading", c: shownPrice ? "warn" : "dim" },
          { t: ` · signed by ${account ?? "your wallet"}`, c: "dim" },
        ]}
      />
      <Line
        w={P}
        cells={[
          account
            ? { t: `[${account.slice(0, 24)}]`, c: "ok", onClick: () => run("disconnect"), label: "disconnect wallet" }
            : {
                t: "[connect wallet]",
                onClick: () => run("connect"),
                title: `a NEAR ${NETWORK_ID} wallet; Meteor works as a browser extension`,
              },
          "  ",
          // always clickable: the command it types says what is still missing (duel, headline, wallet, solver)
          {
            t: "[plant it]",
            c: canSend && account ? "warn" : "dim",
            onClick: () => (duel ? run(lineFor(target, push)) : say("no duel to attack yet", "warn")),
          },
        ]}
      />
      {busy ? (
        <Note w={P} text={`… ${busy}`} c="open" />
      ) : refusal ? (
        <Note w={P} text={`the contract would refuse this: ${refusal}`} c="bad" />
      ) : solverDown ? (
        <Note
          w={P}
          text="solver offline: attacks are paused, nothing can be planted · the board and tail still update"
          c="bad"
        />
      ) : !open ? (
        <Note
          w={P}
          text={`drafting is free · your headline plants once a duel opens${terms ? `; each paid attack in a duel costs ${(terms.r_bps - 10_000) / 100}% more, up to ${near(terms.cap)} NEAR` : ""}`}
        />
      ) : tgtPk ? (
        <Note
          w={P}
          text={
            v2
              ? `the lie reaches ${modelOf(tgtPk)} on its next call · the contract draws whether it arrives as written or with its cues removed`
              : `the lie reaches ${modelOf(tgtPk)} on its next call`
          }
        />
      ) : null}
      {share ? (
        <Line
          w={P}
          cells={[
            { t: "share ", c: "dim" },
            { t: "[copy link]", onClick: () => run("copy") },
            " ",
            { t: "[open card]", href: share.replace(location.origin, "") },
          ]}
        />
      ) : null}
    </Box>
  );

  // ---- pane 5: saboteurs, ranked by flips, with what the contract paid them
  const saboteurs = flips?.saboteurs ?? [];
  const sabW = Math.max(10, W - 3 - 6 - 6 - 11);
  const mineAt = account ? saboteurs.findIndex((x) => x.account === account) : -1;
  const sabShown = saboteurs
    .map((x, i) => ({ x, i }))
    .filter(({ i }) => i < 5 || i === mineAt)
    .slice(0, 6);
  const pane5 = (
    <Box
      n={5}
      title="saboteurs"
      extra={flips?.scanned ? `by flips · last ${flips.scanned.to - flips.scanned.from} duels` : "by flips"}
      w={P}
      on={pane === 5}
      id="pane-5"
    >
      <Line
        w={P}
        cells={[
          {
            t: `   ${"account".padEnd(sabW)} ${"flips".padStart(5)} ${"held".padStart(5)} ${"paid NEAR".padStart(10)}`,
            c: "dim",
          },
        ]}
      />
      {sabShown.map(({ x, i }) => (
        <Line
          key={x.account}
          w={P}
          cells={[
            { t: `${i + 1}  `.slice(0, 3), c: "num" },
            {
              t: col(`${x.account}${x.account === account ? " (you)" : ""}`, sabW),
              c: x.account === account ? "ok" : "hi",
              title: `${x.account}: ${x.attacks} attacks, ${near(x.staked)} NEAR staked, ${near(x.paid)} NEAR paid back`,
            },
            " ",
            { t: String(x.flipped).padStart(5), c: x.flipped ? "warn" : "dim" },
            " ",
            { t: String(x.held).padStart(5), c: "dim" },
            " ",
            { t: near(x.paid).padStart(10), c: "ok" },
          ]}
        />
      ))}
      {!sabShown.length ? (
        <Line
          w={P}
          cells={[{ t: flips ? "nobody has fooled a model on chain yet: be first" : "reading the chain", c: "dim" }]}
        />
      ) : null}
      <Line w={P} cells={[""]} />
      <Note
        w={P}
        text={
          account && mineAt < 0
            ? `${account} shows here once a duel you attacked finishes`
            : "flips = attacks that moved the model to the lie's side · paid = stakes back plus slash shares"
        }
      />
    </Box>
  );

  // ---- command line, palette and status
  const empty = !line.trim();
  const runLine = () => {
    const l = line.trim();
    if (l) run(l);
  };
  const statusRight = snapErr
    ? `arena: ${snapErr}`
    : snap
      ? `updated ${Math.max(0, Math.round((now - snap.at) / 1000))}s ago`
      : "connecting";
  const HW = Math.min(two ? 2 * P + 2 : P, 100); // help box width
  const KW = two ? 16 : 0; // help term column; on a phone each term heads its own lines
  const helpRows: [string, string][] = [
    [
      "the game",
      "Two AI models trade NEAR/USD in a live duel. Pick a side, write a headline that would make that model change its call, sign it. Its next call shows whether it took the bait.",
    ],
    ...GLOSSARY,
    ["rules", "stakes, fees, payouts and every refusal: /llms.txt"],
    ["agents", "MCP server at /api/mcp (it never signs: it hands back the call to sign)"],
    ["keys", "1-5 pane · j/k row · Enter open · i inject · v verify · : or Cmd-K command · ? help · Esc close"],
  ];
  // the palette lists what can work now: claim needs a wallet, copy needs an attack of yours to share
  const commands = COMMANDS.filter((c) => (c.name !== "claim" || account) && (c.name !== "copy" || share));

  return (
    <FlashCtx.Provider value={flash}>
      <div className="term" ref={rootRef}>
        <span className="probe" aria-hidden="true">
          0000000000
        </span>
        <header className="bar">
          <span>{two ? ` NEAR ${NETWORK_ID} ` : ` ${NETWORK_ID} `}</span>
          <span aria-hidden="true">│</span>
          <span>
            {duel && open
              ? ` duel #${duel.id} LIVE ${left} `
              : duel && !duel.resolved
                ? ` duel #${duel.id} closing `
                : pinned
                  ? ` duel #${pinned} `
                  : card
                    ? ` replay #${card.duel} `
                    : " reading the arena "}
          </span>
          <span aria-hidden="true">│</span>
          <span title="live trade price, display only; duels settle on the oracle">{`${two ? " NEAR/USD" : ""} ${spot ? Number(spot.price).toFixed(4) : "…"} `}</span>
          <span aria-hidden="true">│</span>
          <button type="button" className="barbtn" onClick={() => run(account ? "disconnect" : "connect")}>
            {account ? ` ${account} ` : two ? " connect wallet " : " connect "}
          </button>
          <span className="grow" />
          <button type="button" className="barbtn" aria-label="help" onClick={() => run("help")}>
            {two ? " ? help " : " ? "}
          </button>
        </header>
        <h1 className="intro">
          <span className="hi">fool the AI</span>
          <span className="dim">
            {" "}
            · plant one fake headline in a live AI trader, sign it with your wallet, see if its next call takes the bait
            ·{" "}
          </span>
          <button type="button" className="lnk hi" onClick={() => run("help")}>
            how it works
          </button>
        </h1>
        {/* two columns stack independently (2 over 4; 1, 5, 3); one column reads 2, 4, 3, 5, 1: action first */}
        <main className="grid">
          {two ? (
            <>
              <div className="col">
                {pane2}
                {pane4}
              </div>
              <div className="col">
                {pane1}
                {pane5}
                {pane3}
              </div>
            </>
          ) : (
            <div className="col">
              {pane2}
              {pane4}
              {pane3}
              {pane5}
              {pane1}
            </div>
          )}
        </main>
        <dl className="gloss">
          {GLOSSARY.map(([k, v]) => (
            <div key={k}>
              <dt className="hi">{k}</dt>
              <dd className="dim">{v}</dd>
            </div>
          ))}
        </dl>
        <footer className="foot">
          {cmdOpen && (empty || options.length) ? (
            <div className="palette" role="listbox" aria-label={empty ? "commands" : "completions"}>
              {(empty
                ? commands.map((c) => [c.fill, `${c.name} ${c.args}`.trim(), c.what] as const)
                : options.map((o) => [o, o, ""] as const)
              ).map(([fill, name, what]) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected="false"
                  className="opt"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (empty && !fill.endsWith(" ")) return run(fill);
                    const next = empty
                      ? fill
                      : complete(`${line.slice(0, line.lastIndexOf(" ") + 1)}${fill}`, known).line;
                    setLine(next);
                    setOptions([]);
                    cmdRef.current?.focus();
                  }}
                >
                  <span className="hi">{name.padEnd(empty ? 34 : 0)}</span>
                  {what ? <span className="dim">{`  ${what}`}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="status" aria-live="polite">
            <span className="mode">{` ${mode} `}</span>
            <span>{` ${pane}:${PANES[pane - 1]?.[1]} `}</span>
            <span className={msg?.c ?? "dim"}>
              {busy
                ? ` … ${busy}`
                : msg
                  ? ` ${msg.t}`
                  : two
                    ? " j/k move · i inject · v verify · ? help"
                    : " tap a pane, or : for commands"}
            </span>
            <span className="grow" />
            {two ? <span className="dim">{` ${statusRight} `}</span> : null}
          </div>
          <div className="cmd">
            <label htmlFor="cmdline" className="colon">
              :
            </label>
            <input
              id="cmdline"
              ref={cmdRef}
              value={line}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="type a command, or click anything above"
              aria-label="command line"
              onFocus={() => {
                setCmdOpen(true);
                setMode("COMMAND");
              }}
              onBlur={() => {
                setCmdOpen(false);
                setMode("NORMAL");
              }}
              onChange={(e) => {
                setLine(e.target.value);
                setOptions([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runLine();
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  const r = complete(line, known);
                  setLine(r.line);
                  setOptions(r.options);
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  if (!hist.length) return;
                  const i =
                    e.key === "ArrowUp"
                      ? histAt < 0
                        ? hist.length - 1
                        : Math.max(0, histAt - 1)
                      : histAt < 0
                        ? -1
                        : histAt + 1 >= hist.length
                          ? -1
                          : histAt + 1;
                  setHistAt(i);
                  setLine(i < 0 ? "" : (hist[i] ?? ""));
                } else if (e.key === "Escape") {
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
          <nav className="keys" aria-label="panes">
            {PANES.map(([p, name]) => (
              <button key={p} type="button" aria-pressed={pane === p} onClick={() => focusPane(p)}>
                {`${p} ${name}`}
              </button>
            ))}
            <button type="button" onClick={() => cmdRef.current?.focus()}>
              : cmd
            </button>
          </nav>
        </footer>
        {help ? (
          <div className="help" role="dialog" aria-modal="true" aria-labelledby="help-h" tabIndex={-1} ref={helpRef}>
            <Box n="?" title="help" extra="Esc closes" w={HW} on id="help">
              {helpRows.flatMap(([k, v]) => [
                ...(two ? [] : [<Line key={k} w={HW} cells={[{ t: k, c: "hi" }]} />]),
                ...wrap(v, HW - 4 - (two ? KW : 2)).map((l, i) => (
                  <Line
                    // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines of one help entry, in order
                    key={`${k}:${i}`}
                    w={HW}
                    cells={[{ t: two ? (i ? "" : k).padEnd(KW) : "  ", c: "hi" }, l]}
                  />
                )),
              ])}
              <Line w={HW} cells={[""]} />
              {commands.map((c) => (
                <Line
                  key={c.name}
                  w={HW}
                  cells={[
                    { t: `${c.name} ${c.args}`.padEnd(two ? 34 : 0), c: "hi" },
                    { t: `${two ? "" : "  "}${c.what}`, c: "dim" },
                  ]}
                />
              ))}
              <Line w={HW} cells={[""]} />
              <Line
                w={HW}
                cells={[
                  { t: "full record: ", c: "dim" },
                  { t: "/arena", href: "/arena" },
                  { t: "  rules: ", c: "dim" },
                  { t: "/llms.txt", href: "/llms.txt" },
                  { t: "  close: ", c: "dim" },
                  { t: "[Esc]", onClick: () => setHelp(false) },
                ]}
              />
            </Box>
          </div>
        ) : null}
      </div>
    </FlashCtx.Provider>
  );
}
