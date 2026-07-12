import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = join(ROOT, "ai-tmp");
const HAS_SWIPL = spawnSync("swipl", ["--version"], { encoding: "utf8" }).status === 0;
let work = "";

const input = {
  scenario: {
    title: "Choose a change",
    goals: [
      {
        id: "preserve-contract",
        owner: "maintainers",
        statement: "Keep the public contract",
        weight: 1,
        kind: "collective",
        required: true,
      },
    ],
    norms: [
      {
        id: "block-unsafe",
        mode: "forbid",
        targetAction: "unsafe-change",
        reason: "verification failed",
        priority: 10,
      },
    ],
    actions: [
      {
        id: "verified-change",
        label: "Verified change",
        description: "Apply the verified change",
        satisfies: ["preserve-contract"],
      },
      {
        id: "unsafe-change",
        label: "Unsafe change",
        description: "Apply the unverified change",
        satisfies: ["preserve-contract"],
      },
    ],
    notes: [],
  },
  evidence: {
    "verified-change": {
      strength: 0.9,
      confidence: 0.95,
      source: "test output",
    },
  },
} as const;

function run(args: string[], stdin?: string | Uint8Array) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

beforeAll(() => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  work = mkdtempSync(join(TEMP_ROOT, "cli-"));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("generic CLI", () => {
  it("prints root and command help", () => {
    const root = run(["--help"]);
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("goalchainer <command>");
    expect(root.stderr).toBe("");

    const decide = run(["decide", "--help"]);
    expect(decide.status).toBe(0);
    expect(decide.stdout).toContain("--input <path|->");
  });

  it("decides from a file and emits stable pretty JSON", () => {
    const path = join(work, "input.json");
    writeFileSync(path, JSON.stringify(input));
    const result = run(["decide", "--input", path, "--pretty"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^\{\n  "automatic_execution_allowed"/);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.selected).toBe("verified-change");
    expect(payload.status).toBe("recommended");
  });

  it("decides from stdin without mixing diagnostics into stdout", () => {
    const result = run(["decide", "--input", "-"], JSON.stringify(input));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).selected).toBe("verified-change");
  });

  it("returns exit 2 for usage, JSON, and schema errors", () => {
    expect(run(["decide"]).status).toBe(2);
    expect(run(["decide", "--unknown"]).status).toBe(2);

    const invalidJson = run(["decide", "--input", "-"], "{");
    expect(invalidJson.status).toBe(2);
    expect(invalidJson.stderr).toContain("invalid JSON");
    const invalidUtf8 = run(
      ["decide", "--input", "-"],
      Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    expect(invalidUtf8.status).toBe(2);
    expect(invalidUtf8.stderr).toContain("input is not valid UTF-8");

    const invalidSchema = structuredClone(input) as Record<string, any>;
    invalidSchema.scenario.actions[0].satisfies = ["missing-goal"];
    const invalid = run(["decide", "--input", "-"], JSON.stringify(invalidSchema));
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("scenario.actions.0.satisfies.0");
    expect(invalid.stdout).toBe("");

    const contradictory = structuredClone(input) as Record<string, any>;
    contradictory.evidence["verified-change"].projection = "(Answer (STV 0.1 0.1))";
    const contradiction = run(
      ["decide", "--input", "-"],
      JSON.stringify(contradictory),
    );
    expect(contradiction.status).toBe(2);
    expect(contradiction.stderr).toContain("Explicit truth value disagrees with projection STV");
  });

  it("rejects contextual query fields that require an injected reasoner", () => {
    const contextual = structuredClone(input) as Record<string, any>;
    contextual.scenario.actions[0].evidenceQuery = "(Acceptable verified-change)";
    contextual.scenario.actions[0].evidenceAtoms = ["(Observed verified-change)"];

    const result = run(["decide", "--input", "-"], JSON.stringify(contextual));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ContextualQueryEvidenceReasoner");
  });

  it("rejects oversized files and stdin before parsing JSON", () => {
    const oversized = " ".repeat(2 * 1024 * 1024 + 1);
    const path = join(work, "oversized.json");
    writeFileSync(path, oversized);

    const fileResult = run(["decide", "--input", path]);
    expect(fileResult.status).toBe(2);
    expect(fileResult.stderr).toContain("input exceeds 2097152 bytes");
    expect(fileResult.stderr).not.toContain("invalid JSON");

    const stdinResult = run(["decide", "--input", "-"], oversized);
    expect(stdinResult.status).toBe(2);
    expect(stdinResult.stderr).toContain("input exceeds 2097152 bytes");
    expect(stdinResult.stderr).not.toContain("invalid JSON");
  });

  it("rejects unknown commands", () => {
    const result = run(["unknown-command"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("imports without executing the process entry point", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/cli.ts")'],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("installs the shared skill after awaiting the atomic copy", () => {
    const project = join(work, "agent-project");
    mkdirSync(project);
    const result = run([
      "install-skill",
      "--agent",
      "codex",
      "--scope",
      "project",
      "--project-root",
      project,
    ]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { installed: string[] };
    expect(payload.installed).toEqual([join(project, ".agents", "skills", "goalchainer")]);
    expect(readFileSync(join(payload.installed[0]!, "SKILL.md"), "utf8")).toContain(
      "name: goalchainer",
    );

    const repeated = run([
      "install-skill",
      "--agent",
      "codex",
      "--scope",
      "project",
      "--project-root",
      project,
    ]);
    expect(repeated.status).toBe(0);
    expect(JSON.parse(repeated.stdout).unchanged).toEqual(payload.installed);
  });

  it.runIf(HAS_SWIPL)(
    "checks live Prolog parity when SWI-Prolog is available",
    () => {
      const result = run(["prolog-check"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout);
      expect(payload.passed).toBe(true);
      expect(payload.score.rows.map((row: any) => row.prolog[1])).toEqual([
        "blocked",
        "blocked",
        "recommended",
        "candidate",
        "candidate",
        "weak",
      ]);
    },
  );
});
