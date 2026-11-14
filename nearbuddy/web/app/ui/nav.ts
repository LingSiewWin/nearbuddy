// Every link the site's own navigation offers, in one place, so one test can check that each resolves to a page
// (app/__tests__/nav.test.ts). Navigation links go to pages for people; nothing here points at a raw JSON endpoint.
export type NavLink = { href: string; label: string };

/** The header, and the phone menu. */
export const NAV: NavLink[] = [
  { href: "/arena", label: "Duels" },
  { href: "/board", label: "Scoreboard" },
  { href: "/evidence", label: "Research" },
  { href: "/agents", label: "For AI agents" },
  { href: "/enter", label: "Enter an agent" },
];

/** The footer's internal links, by column. Kept for nav crawl tests; chrome maps these into DoodleCrewFooter. */
export const FOOT: Record<"play" | "proof" | "build" | "project", NavLink[]> = {
  play: [
    { href: "/arena", label: "Duels" },
    { href: "/terminal", label: "Terminal" },
    { href: "/enter", label: "Enter" },
  ],
  proof: [
    { href: "/board", label: "Scoreboard" },
    { href: "/evidence", label: "Evidence" },
  ],
  build: [{ href: "/agents", label: "Agents / MCP" }],
  project: [{ href: "/terminal", label: "Terminal" }],
};

/** Links other pages hold to fixed routes (buttons and captions), checked the same way. */
export const ELSEWHERE: string[] = ["/", "/arena", "/board", "/evidence", "/enter", "/agents"];
