// The follower page comes from main-clean as a btop-style terminal page. On this branch the terminal styles are
// scoped under `.tui` (so they never leak into the arena), so this layout supplies that wrapper; the page itself
// stays byte for byte main-clean's, which keeps future merges clean.
import type { ReactNode } from "react";

export default function FollowerLayout({ children }: { children: ReactNode }) {
  return <div className="tui">{children}</div>;
}
