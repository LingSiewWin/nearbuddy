// Plain-language formatting shared by every page (app/ui/format.ts). Run: `cd web && bun test app/__tests__`.
import { describe, expect, test } from "bun:test";
import { mmss, modelName, near, pct, signed, tone, who } from "../ui/format";

const QWEN = "Qwen/Qwen3.8-27B";
const DEEP = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const MINUS = "−";

describe("who / modelName / tone", () => {
  test("who: the family name", () => {
    expect(who(DEEP)).toBe("DeepSeek");
    expect(who(QWEN)).toBe("Qwen3.8");
    expect(who("Qwen/Qwen3.6-35B-A3B-FP8")).toBe("Qwen3.6");
    expect(who("z-ai/glm-5.3-flash")).toBe("GLM");
    expect(who("gpt-5")).toBe("GPT");
  });
  test("who: a name with no leading letters is kept whole; nothing is 'unknown'", () => {
    expect(who("stub/123abc")).toBe("123abc");
    expect(who(null)).toBe("unknown");
    expect(who(undefined)).toBe("unknown");
    expect(who("")).toBe("unknown");
  });
  test("modelName: drops the org and a 4-digit date suffix only", () => {
    expect(modelName(DEEP)).toBe("DeepSeek-V4.1-Flash");
    expect(modelName(QWEN)).toBe("Qwen3.8-27B");
    expect(modelName("org/model-12345")).toBe("model-12345");
    expect(modelName(null)).toBe("");
  });
  test("tone: one class per family, case-insensitive, never red", () => {
    expect(tone(QWEN)).toBe("k-qwen");
    expect(tone(DEEP)).toBe("k-deep");
    expect(tone("QWEN-max")).toBe("k-qwen");
    expect(tone("stub/x")).toBe("k-other");
    expect(tone(null)).toBe("k-other");
  });
});

describe("signed / pct", () => {
  test("a real minus sign (U+2212), a plus for gains, no sign for zero", () => {
    expect(signed(-1.5)).toBe(`${MINUS}1.50`);
    expect(signed(1.234)).toBe("+1.23");
    expect(signed(0)).toBe("0.00");
    expect(signed(-0)).toBe("0.00"); // markPct's score for a losing sub-bps move
  });
  test("pct appends % and takes the digits", () => {
    expect(pct(-0.08)).toBe(`${MINUS}0.08%`);
    expect(pct(0.62, 1)).toBe("+0.6%");
    expect(pct(12, 0)).toBe("+12%");
  });
  test("the ASCII hyphen never appears", () => {
    expect(pct(-3.14)).not.toContain("-");
  });
});

describe("mmss", () => {
  test("minutes and zero-padded seconds, fractions dropped", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(59.9)).toBe("0:59");
    expect(mmss(61)).toBe("1:01");
    expect(mmss(3600)).toBe("60:00");
  });
  test("a clock past zero shows 0:00, not a negative time", () => {
    expect(mmss(-5)).toBe("0:00");
  });
});

describe("near", () => {
  test("rounds to d places and drops trailing zeros", () => {
    expect(near(2.663)).toBe("2.663 NEAR");
    expect(near(2.6630001)).toBe("2.663 NEAR");
    expect(near(1)).toBe("1 NEAR");
    expect(near(0.0004)).toBe("0 NEAR");
    expect(near(1.25, 1)).toBe("1.3 NEAR");
  });
});
