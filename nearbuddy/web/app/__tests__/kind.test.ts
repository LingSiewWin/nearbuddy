// The attack rows' kind column: the spectator's "fake_news/<against|flat>/<bps|no_open>" kinds (22-26 chars) must fit
// the fixed column so the target, hash and block that follow stay in place.
import { expect, test } from "bun:test";
import { KIND_W, kindCell } from "../cells";

const text = (c: ReturnType<typeof kindCell>) => (typeof c === "string" ? c : c.t);

test("spectator kinds read as mode and move, full kind on hover, in a fixed column", () => {
  for (const [kind, shown] of [
    ["fake_news/against/-57.7", "against -57.7"],
    ["fake_news/against/+125.9", "against +125.9"],
    ["fake_news/flat/+0.0", "flat +0.0"],
    ["fake_news/flat/no_open", "flat no_open"],
  ]) {
    const c = kindCell(kind!);
    expect(text(c)).toBe(shown!.padEnd(KIND_W));
    expect(typeof c === "string" ? null : c.title).toBe(kind!);
  }
});

test("an older plain kind is unchanged; anything too long is cut, never wider than the column", () => {
  expect(kindCell("fake_news")).toBe("fake_news".padEnd(KIND_W));
  expect(text(kindCell("fake_news/against/-12345.6"))).toBe("against -12345…");
  for (const k of ["fake_news/against/-12345.6", "a_very_long_custom_kind_name_32c", ""])
    expect(text(kindCell(k))).toHaveLength(KIND_W);
});
