// The match feed: what a model said, read from the chat-completion body a keeper submitted on chain, merged with the
// paid shouts in time order. The fixture is a real submit_completion of duel 5 on v3.nb-keyless-arena-1111.testnet.
import { expect, test } from "bun:test";
import { type FeedLine, keepFor, merge, type Said, type Shout, saidOf } from "../lib/feed";
import fixture from "./fixtures/submit_completion.json";

const body = new TextDecoder().decode(Uint8Array.from(atob(fixture.args.response), (c) => c.charCodeAt(0)));

test("a real completion gives the model's side, size and its one-sentence reason", () => {
  const s = saidOf(body);
  expect(s.side).toBe("Long"); // the contract returned "Long" for this submission
  expect(fixture.value).toBe("Long");
  expect(s.size_bps).toBe(500);
  expect(s.text).toBe(
    "No move since open gives the contrarian fade no signal, so I take a minimal long position with small size.",
  );
});

test("a body that is not a chat completion comes back as its own text, with no call", () => {
  expect(saidOf("not json")).toEqual({ side: null, size_bps: null, text: "not json" });
});

test("a reply that is not JSON is kept as written, markup included", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const s = saidOf(JSON.stringify({ choices: [{ message: { content: hostile } }] }));
  expect(s).toEqual({ side: null, size_bps: null, text: hostile });
});

test("lines merge in time order and only the newest 200 are kept", () => {
  const said = (at: number): Said => ({
    kind: "model",
    at: String(at),
    model: "m",
    side: "Long",
    size_bps: 1,
    text: "",
    tx: "",
  });
  const shout = (at: number): Shout => ({
    kind: "shout",
    at: String(at),
    index: 0,
    by: "a.testnet",
    target: "A",
    text: "x",
    arm: "Cue",
    outcome: "Pending",
  });
  const lines: FeedLine[] = merge([said(3), said(1)], [shout(2)]);
  expect(lines.map((l) => l.at)).toEqual(["1", "2", "3"]);
  const many = merge(
    Array.from({ length: 250 }, (_, i) => said(i)),
    [],
  );
  expect(many.length).toBe(200);
  expect(many[0]?.at).toBe("50");
});

test("an open match's feed is kept 3 s, a just-resolved one 60 s, one resolved over an hour ago for good", () => {
  const close = 1_000_000;
  expect(keepFor(false, close, close - 1)).toBe(3_000);
  expect(keepFor(true, close, close + 60_000)).toBe(60_000);
  expect(keepFor(true, close, close + 3_600_001)).toBe(Number.POSITIVE_INFINITY);
});
