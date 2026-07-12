import { describe, expect, it } from "vitest";

import { stableJson } from "../src/json.js";

describe("stable JSON serialization", () => {
  it("sorts nested records without losing prototype-named keys", () => {
    const value = Object.fromEntries([
      ["z", 1],
      ["__proto__", Object.fromEntries([["toString", 2], ["a", 3]])],
    ]);

    expect(stableJson(value)).toBe('{"__proto__":{"a":3,"toString":2},"z":1}');
  });

  it("preserves array order while sorting object keys", () => {
    expect(stableJson([{ z: 1, a: 2 }, { y: 3, b: 4 }])).toBe(
      '[{"a":2,"z":1},{"b":4,"y":3}]',
    );
  });

  it("uses Python code-point key order and ASCII escapes", () => {
    expect(stableJson({ "2": "two", "10": "ten", "😀": "astral", "\uE000": "bmp" })).toBe(
      '{"10":"ten","2":"two","\\ue000":"bmp","\\ud83d\\ude00":"astral"}',
    );
  });

  it("rejects values JSON would silently omit or coerce", () => {
    expect(() => stableJson(undefined)).toThrow("cannot serialize undefined");
    expect(() => stableJson({ value: Number.NaN })).toThrow("numbers must be finite");
    expect(() => stableJson({ value: 1n })).toThrow("cannot serialize bigint");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJson(cyclic)).toThrow("cyclic values");
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => stableJson(sparse)).toThrow("stable JSON arrays must not contain holes");
    const getterRecord = {} as Record<string, unknown>;
    Object.defineProperty(getterRecord, "value", {
      enumerable: true,
      get: () => "unstable",
    });
    expect(() => stableJson(getterRecord)).toThrow("must be an enumerable data property");
    expect(() => stableJson({ [Symbol("hidden")]: "value" })).toThrow(
      "must contain only string-keyed data properties",
    );
    expect(() => stableJson({}, "false" as any)).toThrow("pretty must be a boolean");
  });
});
