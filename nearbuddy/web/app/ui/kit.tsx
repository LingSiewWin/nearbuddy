"use client";
// Shared components of the Trace design: Button, Segmented, Field, Sheet, Drawer, StatusBar, Skeleton, Amount,
// Countdown, and the four data states (loading, empty, error, stale) every data region goes through.
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { getJson } from "../tui";
import { clock, near, TEST_NOTE } from "./format";

// ---------------------------------------------------------------- Button

type Variant = "attack" | "primary" | "quiet" | "proof" | "link";
const cls = (variant: Variant, fit?: boolean) =>
  variant === "link" ? "btn-link" : `btn btn-${variant}${fit ? " fit" : ""}`;

/** An action. Busy changes the label, never a spinner; disabled is 50% opacity with `why` under it. */
export function Button({
  variant = "quiet",
  busy,
  why,
  fit,
  children,
  ...rest
}: {
  variant?: Variant;
  /** The label while the action runs ("Planting…"); the button is disabled meanwhile. */
  busy?: string | null | undefined;
  /** Why it is disabled, shown under it. */
  why?: string | null | undefined;
  /** Desktop: as wide as its label instead of full width. */
  fit?: boolean;
} & Omit<ComponentProps<"button">, "className">) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        {...rest}
        className={cls(variant, fit)}
        disabled={rest.disabled || !!busy}
        aria-describedby={why ? id : undefined}
      >
        {busy || children}
      </button>
      {why ? (
        <p className="btn-why" id={id}>
          {why}
        </p>
      ) : null}
    </>
  );
}

/** A link that looks like a button. */
export function LinkButton({
  variant = "quiet",
  fit,
  ...rest
}: { variant?: Variant; fit?: boolean } & Omit<ComponentProps<"a">, "className">) {
  return <a {...rest} className={cls(variant, fit)} />;
}

// ---------------------------------------------------------------- Segmented

/** Choose one of two or three: native radios, so the arrow keys work. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="t-label" style={{ marginBottom: 8, padding: 0 }}>
        {label}
      </legend>
      <div className="seg">
        {options.map((o) => (
          <label key={o.value}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- Field

/** A text input or textarea with its label, help, counter, suffix and error. */
export function Field({
  label,
  face = "sans",
  multiline,
  help,
  error,
  count,
  suffix,
  children,
  ...rest
}: {
  label: string;
  face?: "sans" | "serif" | "mono";
  multiline?: number;
  help?: ReactNode;
  error?: ReactNode;
  /** The counter under the field ("212 left") and whether it is past the limit. */
  count?: { text: string; over: boolean } | undefined;
  suffix?: string;
  /** A control of the caller's own (a select) in place of the input. */
  children?: ReactNode;
} & Omit<ComponentProps<"input"> & ComponentProps<"textarea">, "className" | "children">) {
  const id = useId();
  const described = `${id}-u`;
  const common = {
    id,
    className: face === "sans" ? undefined : face,
    "aria-invalid": !!error,
    "aria-describedby": described,
  };
  return (
    <div className={`field${error ? " bad" : ""}`}>
      <label htmlFor={id} className="t-label">
        {label}
      </label>
      <div className="control">
        {children ??
          (multiline ? <textarea rows={multiline} {...rest} {...common} /> : <input {...rest} {...common} />)}
        {suffix ? <span className="suffix">{suffix}</span> : null}
      </div>
      <div id={described}>
        {error ? <p className="error">{error}</p> : null}
        {help || count ? (
          <div className="under">
            {help ? <span>{help}</span> : null}
            {count ? <span className={`count${count.over ? " signal" : ""}`}>{count.text}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Sheet and Drawer

/** A bottom sheet on phone and a 420px dialog on desktop, on the native <dialog>: it traps focus, Esc closes it and
 *  focus returns to the control that opened it. `locked` refuses to close (while a payment is being sent). */
export function Sheet({
  open,
  onClose,
  title,
  locked,
  kind = "sheet",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  locked?: boolean;
  /** `tall`: full height minus 48px on phone (the attack box). `drawer`: a 480px right panel on desktop. */
  kind?: "sheet" | "tall" | "drawer";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  // the element stays mounted and is closed with close(), so the browser hands focus back to the opener
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is the scrim's; the keyboard closes with Esc (onCancel)
    <dialog
      ref={ref}
      className={`sheet${kind === "sheet" ? "" : ` ${kind}`}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault(); // Esc: this component decides, so a locked sheet stays
        if (!locked) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose(); // a click on the scrim
      }}
    >
      {open ? (
        <>
          {kind === "drawer" ? null : <div className="handle" aria-hidden="true" />}
          <div className="sheet-head">
            <h2>{title}</h2>
            <button type="button" className="close" aria-label="Close" disabled={locked} onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="sheet-body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}

/** A side panel on desktop, a full sheet on phone. */
export const Drawer = (p: Omit<ComponentProps<typeof Sheet>, "kind">) => <Sheet {...p} kind="drawer" />;

// ---------------------------------------------------------------- StatusBar, Skeleton

/** The caution bar for stale data, and the error block. */
export function StatusBar({
  kind,
  children,
  reason,
  action,
}: {
  kind: "stale" | "error" | "info";
  children: ReactNode;
  /** The short technical reason, in mono. */
  reason?: string | null;
  action?: { label: string; run: () => void } | undefined;
}) {
  return (
    <div className={`statusbar ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {action ? (
        <button type="button" className="btn-link" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
      {reason ? <span className="reason">{reason}</span> : null}
    </div>
  );
}

/** A loading placeholder in the final shape: text bars, or list rows. Static, no shimmer. */
export function Skeleton({ bars, rows }: { bars?: string[]; rows?: number }) {
  return (
    <div aria-hidden="true">
      {rows
        ? Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders
            <span key={i} className="sk sk-row" />
          ))
        : (bars ?? ["100%", "80%"]).map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders
            <span key={i} className="sk" style={{ width: w }} />
          ))}
    </div>
  );
}

// ---------------------------------------------------------------- Amount, Countdown

/** A NEAR amount: undefined is still loading (a bar), null is unknown ("—"). `note` adds the testnet line once. */
export function Amount({ yocto, note }: { yocto: string | bigint | null | undefined; note?: boolean }) {
  return (
    <>
      <span className="amount">
        {yocto === undefined ? <span className="sk" /> : yocto === null ? "—" : near(yocto)}
      </span>
      {note ? <span className="amount-note">{TEST_NOTE}</span> : null}
    </>
  );
}

/** Time left until `to` (ms): "12:04", "finished" once passed, "—" while the data is stale. */
export function Countdown({ to, now, stale }: { to: number; now: number; stale?: boolean }) {
  if (stale || !now) return <span className="mono">—</span>;
  return <span className="mono">{to > now ? clock((to - now) / 1000) : "finished"}</span>;
}

// ---------------------------------------------------------------- clock and reads

/** Runs `f` now and every `every` ms while the tab is visible; `key` restarts it. */
export function usePoll(f: () => void, every: number, key: string) {
  const run = useRef(f);
  run.current = f;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` restarts the poll on purpose
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") run.current();
    };
    tick();
    const id = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [every, key]);
}

/** The browser's clock in ms, ticking; 0 until mounted (the prerender has no clock). */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(0);
  usePoll(() => setNow(Date.now()), every, "clock");
  return now;
}

/** One data region's read: what it holds, and which of the four states it is in. */
export type Read<T> = {
  data: T | null;
  /** The reason of the last failed read, when nothing can be shown. */
  error: string | null;
  /** First read not back yet. */
  loading: boolean;
  /** Loading for more than 4 s: the region adds "Reading from the chain…". */
  slow: boolean;
  /** Something is shown, but the last good read is older than the region's limit. */
  stale: boolean;
  /** Whole seconds since the last good read. */
  age: number;
  retry: () => void;
};

/** Polls `url` (null: nothing to read) every `every` ms. A failed poll keeps what is shown; it turns stale once the
 *  last good read is older than `staleMs` (0: never, for a fixed snapshot). */
export function useRead<T>(url: string | null, every: number, staleMs: number): Read<T> {
  const [got, setGot] = useState<{ url: string; data: T; at: number } | null>(null);
  const [failed, setFailed] = useState<{ url: string; error: string } | null>(null);
  const [since, setSince] = useState(0);
  const [kick, setKick] = useState(0);
  const now = useNow();
  usePoll(
    () => {
      if (!url) return;
      getJson<T>(url)
        .then((data) => {
          setGot({ url, data, at: Date.now() });
          setFailed(null);
        })
        .catch((e) => setFailed({ url, error: String(e instanceof Error ? e.message : e).slice(0, 160) }));
    },
    every,
    `${url}:${kick}`,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the 4 s clock for each new read
  useEffect(() => setSince(Date.now()), [url, kick]);
  const data = got && got.url === url ? got.data : null;
  const error = !data && failed && failed.url === url ? failed.error : null;
  const age = got && data ? Math.max(0, Math.floor((now - got.at) / 1000)) : 0;
  return {
    data,
    error,
    loading: !!url && !data && !error,
    slow: !!url && !data && !error && now > 0 && since > 0 && now - since > 4000,
    stale: !!data && staleMs > 0 && now > 0 && !!got && now - got.at > staleMs,
    age,
    retry: () => setKick((k) => k + 1),
  };
}

/** The four data states around one region: a skeleton in the final shape while loading (plus "Reading from the
 *  chain…" after 4 s), the error block when nothing can be shown, the caution bar and dimmed content when stale.
 *  Empty is the caller's: it knows what is absent and which action to offer. */
export function Region<T>({
  read,
  skeleton,
  children,
}: {
  read: Read<T>;
  skeleton: ReactNode;
  children: (data: T, stale: boolean) => ReactNode;
}) {
  if (read.data === null) {
    if (read.error)
      return (
        <StatusBar kind="error" reason={read.error} action={{ label: "Try again", run: read.retry }}>
          Could not read from the chain.
        </StatusBar>
      );
    return (
      <div aria-busy="true">
        {skeleton}
        {read.slow ? <p className="t-small caution">Reading from the chain…</p> : null}
      </div>
    );
  }
  return (
    <>
      {read.stale ? <StatusBar kind="stale">{`Last updated ${read.age}s ago. Retrying.`}</StatusBar> : null}
      <div className={read.stale ? "is-stale" : undefined}>{children(read.data, read.stale)}</div>
    </>
  );
}
