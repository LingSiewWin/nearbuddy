// Markdown content negotiation for the four pages agents land on. A request for /, /arena, /duel/<id> or
// /agent/<pk> that prefers text/markdown over text/html in Accept (Claude Code, Cursor and OpenCode send
// `text/markdown, text/html, */*`), or carries ?format=md, is rewritten to its markdown twin under
// /api/v1/md. Every response for those paths says it varies by Accept and links the agent index.
import { type NextRequest, NextResponse } from "next/server";

/** True when Accept names text/markdown and ranks it at least as high as text/html (ties go to the earlier). */
function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const items = accept.split(",").map((part, i) => {
    const [type = "", ...params] = part.toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { type: type.trim(), q: q ? Number(q.slice(2)) : 1, i };
  });
  const md = items.find((x) => x.type === "text/markdown");
  if (!md || !(md.q > 0)) return false;
  const html = ["text/html", "text/*", "*/*"].map((t) => items.find((x) => x.type === t)).find(Boolean);
  return !html || md.q > html.q || (md.q === html.q && md.i < html.i);
}

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  const res =
    searchParams.get("format") === "md" || prefersMarkdown(req.headers.get("accept"))
      ? NextResponse.rewrite(new URL(`/api/v1/md${pathname === "/" ? "/arena" : pathname}`, req.url))
      : NextResponse.next();
  // Next's page renderer replaces Vary on HTML responses (app-page-runtime sets its own), so this survives on
  // the markdown twin only; those pages are no-store, so no shared cache can hand one to the other client.
  res.headers.set("vary", "Accept");
  res.headers.set("link", `</llms.txt>; rel="describedby", <${pathname}?format=md>; rel="alternate"; type="text/markdown"`);
  return res;
}

// pages only: never /api, /_next or static files
export const config = { matcher: ["/", "/arena", "/duel/:id", "/agent/:pk"] };
