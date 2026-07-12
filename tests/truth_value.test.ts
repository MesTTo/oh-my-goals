import { describe, expect, it } from "vitest";

import { parseStv } from "../src/truth_value.js";

describe("simple truth-value parsing", () => {
  it("reads the first embedded STV with decimal, sign, and exponent syntax", () => {
    expect(parseStv("prefix (STV +0.75 2.5e-1) suffix")).toEqual([0.75, 0.25]);
    expect(parseStv("(STV .5 5E-1) then (STV 0.1 0.2)")).toEqual([0.5, 0.5]);
    expect(parseStv("(STV -0 +1)")).toEqual([-0, 1]);
  });

  it("returns null when no complete STV is present", () => {
    const values = [null, undefined, "", "plain text", "(STV)", "(STV 0.5)", "(STV 0.5 0.5 extra)"];
    for (const value of values) expect(parseStv(value)).toBeNull();
  });

  it("rejects non-string inputs before regular-expression coercion", () => {
    expect(() => parseStv(123 as any)).toThrow(
      "STV input must be a string, null, or undefined",
    );
  });

  it("rejects numeric tokens that overflow to non-finite values", () => {
    expect(() => parseStv("(STV 1e999 0.5)")).toThrowError(SyntaxError);
    expect(() => parseStv("(STV 0.5 -1e999)")).toThrow("invalid STV numeric value");
  });

  it("round-trips 1,000 generated finite numeric pairs", () => {
    let state = 0x12345678;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0xffff_ffff;
    };

    for (let index = 0; index < 1_000; index += 1) {
      const strength = next();
      const confidence = next();
      const strengthToken = index % 2 === 0 ? strength.toFixed(12) : strength.toExponential(12);
      const confidenceToken = index % 3 === 0 ? confidence.toFixed(12) : confidence.toExponential(12);
      const parsed = parseStv(`result-${index}: (STV ${strengthToken} ${confidenceToken})`);
      expect(parsed).not.toBeNull();
      expect(parsed![0]).toBe(Number(strengthToken));
      expect(parsed![1]).toBe(Number(confidenceToken));
      expect(Number.isFinite(parsed![0])).toBe(true);
      expect(Number.isFinite(parsed![1])).toBe(true);
    }
  });

  it("handles 500 generated untrusted strings without unexpected error types", () => {
    const alphabet = "()STV0123456789eE+-. abcxyz[]{}$\\\n\t";
    let state = 0x9e3779b9;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };

    for (let index = 0; index < 500; index += 1) {
      const length = 5 + (next() % 60);
      let text = "";
      for (let offset = 0; offset < length; offset += 1) {
        text += alphabet[next() % alphabet.length];
      }
      try {
        const result = parseStv(text);
        if (result !== null) {
          expect(Number.isFinite(result[0])).toBe(true);
          expect(Number.isFinite(result[1])).toBe(true);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(SyntaxError);
      }
    }
  });
});
