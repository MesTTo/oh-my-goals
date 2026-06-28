// The codebase-repair demo: a pure-TS reimplementation that generates a TS repo
// with a seeded leak, runs Node tests, reasons, patches, and reruns. Validated
// functionally (the generated repo language differs from the Python original, so
// the test output and diff are not byte-compared) plus structurally against the
// Python reasoning shape.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCodebaseDemo } from "../src/codebase_demo.js";

const here = dirname(fileURLToPath(import.meta.url));
const pyFixture = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "py-codebase-demo.json"), "utf-8"),
);

describe("codebase-repair demo (pure TS)", () => {
  const report = runCodebaseDemo("");
  const reasoning = report.reasoning as Record<string, any>;
  const pyReasoning = pyFixture.reasoning as Record<string, any>;

  it("fails before the patch and passes after (fail-to-pass)", () => {
    expect((report.pre_patch_tests as any).exit_code).not.toBe(0);
    expect((report.post_patch_tests as any).exit_code).toBe(0);
    expect(report.success).toBe(true);
  });

  it("detects the implementation leak and the buggy passthrough", () => {
    const ids = reasoning.findings.map((f: any) => f.id);
    expect(ids).toContain("implementation-leak");
    expect(reasoning.repair_contract.raw_log_passthrough).toBe(true);
  });

  it("removes the leak after the patch", () => {
    const post = report.post_patch_contract as any;
    expect(post.raw_log_passthrough).toBe(false);
    expect(post.implementation_returns).toContain("diagnostics");
  });

  it("the patch introduces redaction", () => {
    expect(String((report.patch as any).diff)).toContain("[redacted]");
  });

  it("matches the Python reasoning shape (contract, goals, norms, counterfactuals)", () => {
    expect(reasoning.repair_contract.restricted_fields).toEqual(pyReasoning.repair_contract.restricted_fields);
    expect(reasoning.repair_contract.diagnostic_fields).toEqual(pyReasoning.repair_contract.diagnostic_fields);
    expect(reasoning.goal_model).toEqual(pyReasoning.goal_model);
    expect(reasoning.counterfactuals).toEqual(pyReasoning.counterfactuals);
    expect(reasoning.findings.map((f: any) => f.id)).toEqual(pyReasoning.findings.map((f: any) => f.id));
    expect(reasoning.propositions.length).toBe(pyReasoning.propositions.length);
  });
});
