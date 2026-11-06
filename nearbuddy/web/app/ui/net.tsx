"use client";
// Network pill in the top bar: the newest arena block seen on the tape and how long ago it landed.
import { useEffect, useState } from "react";
import { useNow } from "../lib/live";

export function NetPill() {
  const [last, setLast] = useState<{ block: number; at: number } | null>(null);
  const now = useNow(1_000);
  useEffect(() => {
    let alive = true;
    const get = () =>
      fetch("/api/v1/events?limit=1")
        .then((r) => r.json())
        .then((j) => {
          const e = j.events?.[0];
          if (alive && e) setLast({ block: e.block, at: e.at });
        })
        .catch(() => {});
    get();
    const id = setInterval(get, 6_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const age = last && now ? Math.max(0, Math.round((now - last.at) / 1000)) : null;
  return (
    <span className="net" title="Newest arena transaction on NEAR testnet">
      <i className={`live${age != null && age < 120 ? "" : " off"}`} />
      <span className="txt">
        NEAR testnet{last ? `, block ${last.block.toLocaleString("en-US")}` : ""}
        {age != null ? ` · ${age < 60 ? `${age} s` : `${Math.round(age / 60)} min`} ago` : ""}
      </span>
    </span>
  );
}
