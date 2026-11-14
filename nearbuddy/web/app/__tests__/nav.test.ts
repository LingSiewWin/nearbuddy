// A crawl of the site's own navigation: every link in the header, the phone menu and the footer, and every fixed
// route a page links to in its source, must resolve to a page file. Nothing in the navigation may point at an API
// route (raw JSON).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ELSEWHERE, FOOT, NAV } from "../ui/nav";

const APP = join(import.meta.dir, "..");
/** The page file a path resolves to: a static segment, or a dynamic `[x]` folder for it. */
function resolves(path: string): boolean {
  let dir = APP;
  for (const seg of path.split("/").filter(Boolean)) {
    const exact = join(dir, seg);
    if (existsSync(exact) && statSync(exact).isDirectory()) dir = exact;
    else {
      const dynamic = readdirSync(dir).find((d) => /^\[.+\]$/.test(d) && statSync(join(dir, d)).isDirectory());
      if (!dynamic) return false;
      dir = join(dir, dynamic);
    }
  }
  return existsSync(join(dir, "page.tsx"));
}
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" || f === "api" ? [] : files(p);
    return /\.tsx$/.test(f) ? [p] : [];
  });

test("every navigation link resolves to a page, and none is an API route", () => {
  const links = [...NAV, ...Object.values(FOOT).flat()].map((l) => l.href).concat(ELSEWHERE);
  expect(links.length).toBeGreaterThan(8);
  for (const href of links) {
    expect(href.startsWith("/api")).toBe(false);
    expect([href, resolves(href)]).toEqual([href, true]);
  }
});

test("every fixed internal link written in a page or component resolves to a page", () => {
  const seen = new Set<string>();
  for (const f of files(APP)) {
    const src = readFileSync(f, "utf8");
    // href="/x", href={"/x"} and href={`/x/${…}`} up to the first dynamic part
    for (const m of src.matchAll(/href=\{?["`](\/[a-z0-9/_.-]*)/g)) seen.add(m[1] as string);
  }
  expect(seen.has("/agents")).toBe(true);
  // a prefix that ends where a dynamic part starts ("/duel/", "/i/", "/agent/") is checked as its folder
  for (const href of seen) {
    const path = href.replace(/\/$/, "");
    if (href.startsWith("/api/")) {
      // only the machine-readable documents a page may cite: never a navigation target for people
      expect([href, ["/api/mcp", "/api/card"].some((ok) => href.startsWith(ok))]).toEqual([href, true]);
      continue;
    }
    const dir = join(APP, ...path.split("/").filter(Boolean));
    // a page; or the folder a dynamic link continues into; or the one plain-text document (/llms.txt)
    const ok = resolves(path || "/") || (href.endsWith("/") && existsSync(dir)) || href === "/llms.txt";
    expect([href, ok]).toEqual([href, true]);
  }
});

test("the resolver itself: a missing page is reported", () => {
  expect(resolves("/")).toBe(true);
  expect(resolves("/duel/575")).toBe(true);
  expect(resolves("/no-such-page")).toBe(false);
  expect(resolves("/api/mcp")).toBe(false); // a route, not a page
});
