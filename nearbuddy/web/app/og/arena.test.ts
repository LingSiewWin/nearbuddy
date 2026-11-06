// The arena card's headline picker and duel line, checked on fixture rows. Run: `cd web && bun test app/og`.
import { describe, expect, test } from "bun:test";
import type { Summary } from "../api/arena";
import type { Decision } from "../api/dataset";
import { contrast, duelLine, groups } from "./arena";

const QWEN = "Qwen/Qwen3.8-27B";
const DEEP = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const row = (model: string, arm: string, verdict: Decision["verdict"], attack: string | null = "fake"): Decision => ({
  duel: "1",
  agent: model,
  model,
  arm,
  side: "Long",
  size: 50,
  nonce: "0",
  reason: "",
  brief: "",
  attack,
  pushed: null,
  verdict,
  next: null,
  right: null,
  tx: null,
});
const many = (n: number, model: string, arm: string, verdict: Decision["verdict"]) =>
  Array.from({ length: n }, () => row(model, arm, verdict));

describe("contrast", () => {
  test("picks the most fooled group and the most guarded group of another family", () => {
    const rows = [
      ...many(18, QWEN, "naive", "fell"),
      row(QWEN, "naive", "unmoved"),
      ...many(9, QWEN, "hardened", "resisted"),
      row(QWEN, "hardened", "fell"),
      ...many(25, DEEP, "hardened", "resisted"),
      ...many(4, DEEP, "C", "resisted"), // too few to quote
      row(DEEP, "naive", "fell", null), // not attacked: ignored
    ];
    const { fooled, guarded } = contrast(groups(rows));
    expect([fooled?.model, fooled?.arm, fooled?.fell, fooled?.rows.length]).toEqual([QWEN, "naive", 18, 19]);
    expect([guarded?.model, guarded?.arm, guarded?.resisted, guarded?.rows.length]).toEqual([DEEP, "hardened", 25, 25]);
  });

  test("falls back to the same family when no other family has called anything out", () => {
    const { fooled, guarded } = contrast(
      groups([...many(6, QWEN, "naive", "fell"), ...many(6, QWEN, "A", "resisted")]),
    );
    expect([fooled?.arm, guarded?.arm]).toEqual(["naive", "A"]);
  });

  test("quotes nothing without enough attacks", () => {
    expect(contrast(groups(many(4, QWEN, "naive", "fell")))).toEqual({ fooled: null, guarded: null });
  });
});

describe("duelLine", () => {
  const side = (model: string, agent: string, s: "Long" | "Short" | null, ret = 0) => ({
    agent,
    model,
    side: s,
    size_pct: 50,
    verified: true,
    return_pct: ret,
  });
  const text = (s: ReturnType<typeof duelLine>) => s.map((x) => (typeof x === "string" ? x : x.t)).join(" ");

  test("live duel: both calls and the clock", () => {
    const s = {
      live: { duel: 342, seconds_left: 91, a: side(DEEP, "d", "Long"), b: side(QWEN, "q", null) },
      recent: [],
    } as unknown as Summary;
    expect(text(duelLine(s))).toBe("Duel 342 live: DeepSeek long, Qwen deciding, 1:31 left");
  });

  test("no live duel: the last result, winner first", () => {
    const s = {
      live: null,
      recent: [{ duel: 341, winner: "q", a: side(DEEP, "d", "Short", -0.05), b: side(QWEN, "q", "Long", 0.12) }],
    } as unknown as Summary;
    expect(text(duelLine(s))).toBe("Duel 341: Qwen beat DeepSeek +0.12% to −0.05%");
  });
});
