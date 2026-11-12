// The Content-Security-Policy against the live pages: every page and the wallet picker load with no violation, and
// an injected inline script, inline handler or third-party script is refused. Needs the network (RPC through the
// api routes, NEAR Connect's wallet list).
import { expect, type Page, test } from "@playwright/test";

type Violation = { directive: string; blocked: string; frame: string };
declare global {
  interface Window {
    __csp: Violation[];
    __pwned?: number;
  }
}

/** Every `securitypolicyviolation` in any frame of the page, plus console reports of one, collected from the start. */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const logged: string[] = [];
  page.on("console", (m) => {
    if (/Content.Security.Policy/i.test(m.text())) logged.push(m.text());
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, frame: location.href }),
    );
  });
  return async () => {
    const seen = await Promise.all(
      page.frames().map((f) => f.evaluate(() => window.__csp ?? []).catch(() => [] as Violation[])),
    );
    return [...seen.flat().map((v) => `${v.directive} ${v.blocked} (${v.frame})`), ...logged];
  };
}

async function live(page: Page): Promise<{ duel: number; pk: string }> {
  const snap = await (await page.request.get("/api/arena")).json();
  return { duel: Number(snap.config.next_duel) - 1, pk: snap.leaderboard[0]?.pk as string };
}

test("pages carry the policy and load with no violation", async ({ page }) => {
  const { duel, pk } = await live(page);
  expect(pk).toBeTruthy();
  const violations = await watch(page);
  for (const [path, ready] of [
    ["/", "#boards"],
    ["/terminal", "#pane-2"],
    ["/arena", "pre a[href^='/agent/']"],
    [`/duel/${duel}`, "pre a[href^='/agent/']"],
    [`/agent/${encodeURIComponent(pk)}`, "pre"],
    ["/enter", "#enter-request"],
    ["/llms.txt", "body"],
    ["/api/mcp", "body"],
  ] as const) {
    const res = await page.goto(path);
    expect(res?.headers()["x-content-type-options"], path).toBe("nosniff");
    if (!path.startsWith("/api/")) {
      const script = res?.headers()["content-security-policy"]?.match(/script-src [^;]*/)?.[0] ?? "";
      expect(script, path).toMatch(/^script-src 'self' 'nonce-[\w+/=]+' /);
      expect(script, path).not.toContain("unsafe-inline");
    }
    await expect(page.locator(ready).first(), path).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {}); // a page that polls never idles; the wait is a floor
    expect(await violations(), path).toEqual([]);
  }
});

test("connect opens the wallet picker, and a wallet starts in its sandbox, with no violation", async ({ page }) => {
  const violations = await watch(page);
  await page.goto("/terminal");
  await page.locator("button.barbtn", { hasText: "connect" }).click();
  const picker = page.locator(".hot-connector-popup");
  await expect(picker.getByText("Select wallet")).toBeVisible({ timeout: 30_000 });
  for (const name of ["Meteor Wallet", "Intear Wallet", "Ethereum Wallets", "NEAR CLI"])
    await expect(picker.getByText(name, { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {}); // the wallet icons
  // the wallet's code runs in a srcdoc iframe that inherits the page's policy: it needs the nonce to start at all
  await picker.getByText("NEAR CLI", { exact: true }).click();
  await expect(page.frameLocator("iframe").first().getByText("Connect with NEAR CLI")).toBeVisible({ timeout: 30_000 });
  expect(await violations()).toEqual([]);
});

test("an injected inline script, inline handler and third-party script are refused", async ({ page }) => {
  const violations = await watch(page);
  await page.goto("/terminal");
  await expect(page.locator("#pane-1")).toBeVisible();
  await page.evaluate(() => {
    const inline = document.createElement("script");
    inline.textContent = "window.__pwned = 1";
    document.body.append(inline);
    document.body.insertAdjacentHTML("beforeend", `<img src="/favicon.ico?x" onload="window.__pwned = 2">`);
    const remote = document.createElement("script");
    remote.src = "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js";
    document.body.append(remote);
  });
  await expect
    .poll(violations)
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^script-src-elem inline /),
        expect.stringMatching(/^script-src-attr inline /),
        expect.stringMatching(/^script-src-elem https:\/\/cdn\.jsdelivr\.net\/npm\/lodash/),
      ]),
    );
  expect(await page.evaluate(() => [window.__pwned, typeof (window as { _?: unknown })._])).toEqual([
    undefined,
    "undefined",
  ]);
});
