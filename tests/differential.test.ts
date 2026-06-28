// Differential oracle: the TypeScript port on @metta-ts must reproduce the Python
// reference outputs (fixtures/py-*.json) value-for-value. The only fields allowed
// to differ are the runtime labels -- the TS port honestly says "@metta-ts" where
// the Python said "PeTTa" -- so those keys are ignored in the comparison.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { solveIncident } from "../src/pipeline.js";
import { runValidation } from "../src/validate.js";
import { deriveIncident } from "../src/snars.js";
import { runMotivation } from "../src/cli_support.js";
import { runDirective } from "../src/directive.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "..", "fixtures", `py-${name}.json`), "utf-8"));

// Keys whose values are intentionally different (runtime labels) and skipped.
const IGNORED_KEYS = new Set(["engine", "source", "score_engine", "runtime"]);

/** Recursively assert `actual` matches `expected`, with float tolerance and
 * ignoring label keys. Returns the list of mismatches (empty == match). */
function diff(actual: unknown, expected: unknown, path = ""): string[] {
  const out: string[] = [];
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(actual - expected) > 1e-6) out.push(`${path}: ${actual} != ${expected}`);
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: not an array`];
    if (actual.length !== expected.length) out.push(`${path}: length ${actual.length} != ${expected.length}`);
    for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
      out.push(...diff(actual[i], expected[i], `${path}[${i}]`));
    }
    return out;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return [`${path}: not an object`];
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (IGNORED_KEYS.has(key)) continue;
      if (!(key in a)) {
        out.push(`${path}.${key}: missing`);
        continue;
      }
      out.push(...diff(a[key], e[key], `${path}.${key}`));
    }
    return out;
  }
  if (actual !== expected) out.push(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  return out;
}

const req =
  "Checkout is down. Engineering wants to paste raw logs into the incident room. " +
  "Support says the logs may include customer emails, order IDs, and request payloads.";

describe("differential oracle vs Python fixtures", () => {
  it("validate battery matches", () => {
    expect(diff(runValidation(), fixture("validate"))).toEqual([]);
  });

  it("solve (decide + execute + leak check) matches", () => {
    expect(diff(solveIncident(req), fixture("solve"))).toEqual([]);
  });

  it("snars deduction matches", () => {
    expect(diff(deriveIncident(req), fixture("snars"))).toEqual([]);
  });

  it("motivation consensus matches", () => {
    expect(diff(runMotivation(req), fixture("motivation"))).toEqual([]);
  });

  it("directive task mapping matches", () => {
    expect(diff(runDirective(req), fixture("directive"))).toEqual([]);
  });
});
