// Followers across deploys: list_followers before deploy 15, the solver's GET /followers after it, empty when
// neither answers. Run: `cd web && bun test` or `bun test web/app` from nearbuddy.
import { expect, test } from "bun:test";
import { followersOf } from "../api/followers";

const M = { allowance: "1", spent: "0" };
const noFetch = (async () => {
  throw new Error("fetch not expected");
}) as unknown as typeof fetch;

test("deploy 14: the list_followers view answers", async () => {
  const view = async (method: string) => (method === "list_followers" ? [["f.testnet", M]] : null);
  expect(await followersOf(view, "pk", noFetch)).toEqual([["f.testnet", M]]);
});

test("deploy 15: the view is gone, the solver answers, the pk is url-encoded", async () => {
  const urls: string[] = [];
  const view = async () => {
    throw new Error("MethodNotFound");
  };
  const fetchFn = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify([["f.testnet", M]]));
  }) as unknown as typeof fetch;
  expect(await followersOf(view, "a+b/c=", fetchFn)).toEqual([["f.testnet", M]]);
  expect(urls[0]).toEndWith("/followers?pk=a%2Bb%2Fc%3D");
});

test("neither answers: empty, never a thrown page", async () => {
  const view = async () => {
    throw new Error("MethodNotFound");
  };
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await followersOf(view, "pk", down)).toEqual([]);
  const odd = (async () => new Response(JSON.stringify({ error: "x" }))) as unknown as typeof fetch;
  expect(await followersOf(view, "pk", odd)).toEqual([]);
});
