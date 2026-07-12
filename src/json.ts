// Deterministic strict JSON with Unicode code-point key ordering.

import { assertDenseArray, assertPlainRecord } from "./records.js";

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007F-\uFFFF]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function stableJsonText(
  value: unknown,
  pretty: boolean,
  depth: number,
  ancestors: WeakSet<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string") return asciiJsonString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stable JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`stable JSON cannot serialize ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("stable JSON cannot serialize cyclic values");
  ancestors.add(value);
  try {
    const indent = pretty ? "  ".repeat(depth) : "";
    const childIndent = pretty ? "  ".repeat(depth + 1) : "";
    if (Array.isArray(value)) {
      assertDenseArray(value, "stable JSON arrays");
      if (value.length === 0) return "[]";
      const items = Array.from(value, (item) => stableJsonText(item, pretty, depth + 1, ancestors));
      return pretty
        ? `[\n${childIndent}${items.join(`,\n${childIndent}`)}\n${indent}]`
        : `[${items.join(",")}]`;
    }
    assertPlainRecord(value, "stable JSON records");
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input).sort(compareCodePoints);
    if (keys.length === 0) return "{}";
    const separator = pretty ? ": " : ":";
    const entries = keys.map(
      (key) =>
        `${asciiJsonString(key)}${separator}${stableJsonText(input[key], pretty, depth + 1, ancestors)}`,
    );
    return pretty
      ? `{\n${childIndent}${entries.join(`,\n${childIndent}`)}\n${indent}}`
      : `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function stableJson(value: unknown, pretty = false): string {
  if (typeof pretty !== "boolean") throw new TypeError("pretty must be a boolean");
  return stableJsonText(value, pretty, 0, new WeakSet());
}
