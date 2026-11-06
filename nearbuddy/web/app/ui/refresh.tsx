"use client";
// Re-renders the server components every 20 s while the tab is visible: an agent page stays current, and a page
// that could not read the chain (a throttled public RPC) tries again by itself.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function Refresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 20_000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
