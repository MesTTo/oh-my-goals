// Generated codebase repair demo for GoalChainer, pure TypeScript.
// Ports goal_chainer/codebase_demo.py. The original regenerated a Python repo and
// ran pytest; this regenerates a TypeScript repo with the same seeded leak and the
// same policy docs, runs its tests with Node, reasons over the docs/tests/code,
// patches the implementation, and reruns the tests. No Python, no pytest.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProposition, type StructuredProposition } from "./hyperbase.js";
import { loadColoreContext } from "./ontology.js";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DEMO_REPO = join(PKG_ROOT, "artifacts/codebase-demo/checkout-status-demo");

interface CommandResult {
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
}

interface CodebaseContract {
  restricted_fields: string[];
  customer_update_fields: string[];
  diagnostic_fields: string[];
  implementation_returns: string[];
  implementation_sources: Record<string, string>;
  raw_log_passthrough: boolean;
}

function run(repo: string, command: string[]): CommandResult {
  try {
    const stdout = execFileSync(command[0]!, command.slice(1), { cwd: repo, encoding: "utf-8" });
    return { command, exit_code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      command,
      exit_code: err.status ?? 1,
      stdout: (err.stdout ?? "").toString().trim(),
      stderr: (err.stderr ?? "").toString().trim(),
    };
  }
}

function git(repo: string, ...args: string[]): CommandResult {
  const result = run(repo, ["git", ...args]);
  if (result.exit_code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}:\n${result.stderr || result.stdout}`);
  }
  return result;
}

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
};

// ---- generated repo content -----------------------------------------------

const README = `# Checkout Status Service

This small service builds customer-facing incident updates for checkout outages.
The current issue is intentionally seeded for the GoalChainer codebase demo.
`;

const ISSUE = `# Issue: customer update leaks restricted checkout data

Support reported that checkout incident updates may include raw checkout logs.
Those logs can contain customer emails, order IDs, request payloads, access
tokens, and internal traces. Fix the update builder so the customer-facing
message keeps useful operational context without exposing restricted data.
`;

const POLICY = `# Customer Update Policy

External customer updates must not include raw checkout logs or restricted
checkout fields.

## Restricted data keys

- \`customer_email\`
- \`order_id\`
- \`request_payload\`
- \`access_token\`
- \`stack_trace\`
- \`raw_log\`

Redaction must happen before any external customer update is built.
`;

const STATUS_CONTRACT = `# Status Builder Contract

\`buildCustomerUpdate(incident)\` returns the object that can be sent to
customers during an incident.

## Returned customer update keys

- \`service\`
- \`status\`
- \`summary\`
- \`diagnostics\`
- \`next_update\`

## Allowed diagnostic keys

- \`error_code\`

The returned object must never contain restricted values from \`raw_log\`.
`;

const BUGGY_BUILDER = `// Build customer-facing checkout incident updates.

export function buildCustomerUpdate(incident) {
  return {
    service: incident.service,
    status: incident.status,
    summary: incident.summary,
    raw_log: incident.raw_log,
  };
}
`;

function fixedBuilder(contract: CodebaseContract): string {
  const restricted = contract.restricted_fields.filter((f) => f !== "raw_log");
  const diagnostics = contract.diagnostic_fields;
  const lit = (xs: string[]): string => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  return `// Build customer-facing checkout incident updates.

const RESTRICTED_FIELDS = ${lit(restricted)};
const ALLOWED_DIAGNOSTICS = ${lit(diagnostics)};

export function redactIncidentLog(rawLog) {
  const diagnostics = {};
  for (const [key, value] of Object.entries(rawLog)) {
    if (RESTRICTED_FIELDS.includes(key)) diagnostics[key] = "[redacted]";
    else if (ALLOWED_DIAGNOSTICS.includes(key)) diagnostics[key] = value;
  }
  return diagnostics;
}

export function buildCustomerUpdate(incident) {
  return {
    service: incident.service,
    status: incident.status,
    summary: incident.summary,
    diagnostics: redactIncidentLog(incident.raw_log ?? {}),
    next_update: incident.next_update ?? "15 minutes",
  };
}
`;
}

const TEST = `import assert from "node:assert";
import { buildCustomerUpdate } from "./src/updateBuilder.mjs";

const incident = {
  service: "checkout",
  status: "degraded",
  summary: "Checkout payment retries are timing out.",
  next_update: "15 minutes",
  raw_log: {
    customer_email: "ava@example.com",
    order_id: "ORD-19942",
    request_payload: "{card_token: tok_live_secret}",
    access_token: "tok_live_secret",
    stack_trace: "Traceback: internal checkout worker path",
    error_code: "PAYMENT_TIMEOUT",
  },
};

const update = buildCustomerUpdate(incident);
const dumped = JSON.stringify(update);
for (const secret of ["ava@example.com", "ORD-19942", "tok_live_secret", "Traceback"]) {
  assert.ok(!dumped.includes(secret), \`leaked \${secret}\`);
}
assert.ok(dumped.includes("[redacted]"), "expected redaction marker");
assert.strictEqual(update.service, "checkout");
assert.strictEqual(update.status, "degraded");
assert.ok(String(update.summary).includes("payment retries"));
assert.strictEqual(update.diagnostics.error_code, "PAYMENT_TIMEOUT");
assert.strictEqual(update.next_update, "15 minutes");
console.log("all checks passed");
`;

const PACKAGE_JSON = `{
  "name": "checkout-status-demo",
  "version": "0.1.0",
  "type": "module",
  "private": true
}
`;

function writeDemoFiles(repo: string): void {
  write(join(repo, "README.md"), README);
  write(join(repo, "ISSUE.md"), ISSUE);
  write(join(repo, "docs/customer_update_policy.md"), POLICY);
  write(join(repo, "docs/status_contract.md"), STATUS_CONTRACT);
  write(join(repo, "package.json"), PACKAGE_JSON);
  write(join(repo, "src/updateBuilder.mjs"), BUGGY_BUILDER);
  write(join(repo, "test.mjs"), TEST);
}

function regenerateDemoRepo(repo: string): void {
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  writeDemoFiles(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Ahmad Mesto");
  git(repo, "config", "user.email", "metta.mestto@gmail.com");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "Seed checkout status service bug");
}

const runTests = (repo: string): CommandResult => run(repo, ["node", "--test", "test.mjs"]);

// ---- inspection -----------------------------------------------------------

function extractBacktickList(text: string, heading: string): string[] {
  const items: string[] = [];
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.toLowerCase() === `## ${heading}`.toLowerCase()) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("## ") && items.length > 0) break;
    if (!line) continue;
    if (items.length > 0 && !line.startsWith("-")) break;
    if (!line.startsWith("-")) continue;
    const m = line.match(/`([^`]+)`/);
    if (m) items.push(m[1]!);
  }
  return items;
}

function inspectUpdateBuilder(source: string): {
  returnedFields: string[];
  fieldSources: Record<string, string>;
  rawLogPassthrough: boolean;
} {
  const returnedFields: string[] = [];
  const fieldSources: Record<string, string> = {};
  const body = source.match(/return\s*{([\s\S]*?)}/);
  if (body) {
    for (const line of body[1]!.split(",")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      const value = m[2]!.trim();
      returnedFields.push(key);
      const sub = value.match(/^incident\.([A-Za-z_][A-Za-z0-9_]*)$/);
      fieldSources[key] = sub ? sub[1]! : value;
    }
  }
  return {
    returnedFields,
    fieldSources,
    rawLogPassthrough: fieldSources.raw_log === "raw_log",
  };
}

function inspectDemoRepo(repo: string): CodebaseContract {
  const policy = readFileSync(join(repo, "docs/customer_update_policy.md"), "utf-8");
  const statusContract = readFileSync(join(repo, "docs/status_contract.md"), "utf-8");
  const impl = inspectUpdateBuilder(readFileSync(join(repo, "src/updateBuilder.mjs"), "utf-8"));
  return {
    restricted_fields: extractBacktickList(policy, "Restricted data keys"),
    customer_update_fields: extractBacktickList(statusContract, "Returned customer update keys"),
    diagnostic_fields: extractBacktickList(statusContract, "Allowed diagnostic keys"),
    implementation_returns: impl.returnedFields,
    implementation_sources: impl.fieldSources,
    raw_log_passthrough: impl.rawLogPassthrough,
  };
}

function sourceRef(repo: string, relativePath: string, needle: string): Record<string, unknown> {
  const path = join(repo, relativePath);
  let line = 1;
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(needle)) {
        line = i + 1;
        break;
      }
    }
  }
  return { path: relativePath, line, needle };
}

const formatSource = (repo: string, relativePath: string, needle: string): string => {
  const ref = sourceRef(repo, relativePath, needle);
  return `${ref.path}:${ref.line}`;
};

// ---- reasoning ------------------------------------------------------------

function codebasePropositions(repo: string, contract: CodebaseContract): StructuredProposition[] {
  const restricted = contract.restricted_fields.join(", ");
  const returned = contract.implementation_returns.join(", ");
  return [
    makeProposition({ propId: "doc-policy-1", sentence: `External customer updates forbid these restricted fields: ${restricted}.`, predicate: "forbids", subject: "customer update policy", object: "restricted checkout fields", source: formatSource(repo, "docs/customer_update_policy.md", "Restricted data keys") }),
    makeProposition({ propId: "test-contract-1", sentence: "The regression test rejects restricted checkout values in the customer update.", predicate: "rejects", subject: "privacy regression test", object: "restricted checkout values", source: formatSource(repo, "test.mjs", "leaked") }),
    makeProposition({ propId: "code-bug-1", sentence: `The update builder returns these fields: ${returned}.`, predicate: "returns", subject: "buildCustomerUpdate", object: contract.raw_log_passthrough ? "raw_log unchanged" : "customer update object", source: formatSource(repo, "src/updateBuilder.mjs", "raw_log") }),
    makeProposition({ propId: "fix-order-1", sentence: "Redaction happens before external customer update.", predicate: "before", subject: "redaction", object: "external customer update", source: "COLORE timepoints/lp_ordering/a1", ontologyHint: "COLORE before transitivity keeps the fix order explicit" }),
  ];
}

function findings(repo: string, contract: CodebaseContract): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [
    { id: "policy-contract", severity: "blocking", source: sourceRef(repo, "docs/customer_update_policy.md", "Restricted data keys"), claim: `Customer updates cannot contain ${contract.restricted_fields.join(", ")}.` },
    { id: "test-contract", severity: "blocking", source: sourceRef(repo, "test.mjs", "leaked"), claim: "The regression tests check exact restricted values and required context." },
  ];
  const restrictedReturns = contract.implementation_returns.filter((f) => contract.restricted_fields.includes(f));
  if (contract.raw_log_passthrough || restrictedReturns.length > 0) {
    rows.push({ id: "implementation-leak", severity: "blocking", source: sourceRef(repo, "src/updateBuilder.mjs", "raw_log"), claim: "The implementation copies a restricted raw_log field into the external update." });
  }
  return rows;
}

function goalModel(contract: CodebaseContract): Record<string, unknown> {
  return {
    individual_goals: [
      { id: "protect-customer-data", statement: "Do not expose customer identifiers, tokens, payloads, or traces.", required: true, evidence: contract.restricted_fields },
    ],
    collective_goals: [
      { id: "maintain-service-trust", statement: "Give customers useful status context without publishing internal logs.", required: true, evidence: contract.customer_update_fields },
      { id: "coordinate-incident-response", statement: "Keep non-sensitive diagnostics that help responders identify the failure mode.", required: true, evidence: contract.diagnostic_fields },
    ],
    norms: [
      { id: "forbid-restricted-customer-update", status: "forbid", target: "external update containing restricted fields", priority: 100 },
      { id: "oblige-inform-customers", status: "oblige", target: "external update with safe operational context", priority: 70 },
    ],
  };
}

function counterfactuals(contract: CodebaseContract): Record<string, unknown>[] {
  const overlap = contract.implementation_returns.filter((f) => contract.restricted_fields.includes(f)).sort();
  return [
    { action: "return raw_log unchanged", status: "blocked", violates: ["protect-customer-data", "forbid-restricted-customer-update"], evidence: { returned_fields: contract.implementation_returns, restricted_overlap: overlap } },
    { action: "delete diagnostics entirely", status: "weak", violates: ["coordinate-incident-response"], evidence: { required_context: contract.diagnostic_fields } },
    { action: "redact restricted fields and keep allowed diagnostics", status: "selected", satisfies: ["protect-customer-data", "maintain-service-trust", "coordinate-incident-response", "oblige-inform-customers"] },
  ];
}

function analyzeDemoRepo(repo: string, request: string, contract: CodebaseContract): Record<string, unknown> {
  const ontology = loadColoreContext();
  return {
    documents_examined: [
      sourceRef(repo, "ISSUE.md", "raw checkout logs"),
      sourceRef(repo, "docs/customer_update_policy.md", "Restricted data keys"),
      sourceRef(repo, "docs/status_contract.md", "Returned customer update keys"),
      sourceRef(repo, "test.mjs", "leaked"),
      sourceRef(repo, "src/updateBuilder.mjs", "raw_log"),
    ],
    repair_contract: contract,
    hyperbase_contract: {
      shape: '(hb tree ID (sh (tag P v so ()) "predicate" ...))',
      purpose: "make docs, tests, and code claims queryable as structured propositions",
    },
    propositions: codebasePropositions(repo, contract).map((p) => ({ ...p })),
    goal_model: goalModel(contract),
    ontology: {
      source_available: ontology.source_available,
      source_path: ontology.source_path,
      projection_rules: ontology.projection_rules,
    },
    findings: findings(repo, contract),
    counterfactuals: counterfactuals(contract),
    selected_fix: {
      id: "redact-before-customer-update",
      reason:
        "The policy names restricted fields, the status contract names the permitted " +
        "customer update shape, and the implementation returns raw_log unchanged.",
      ordered_steps: ["read raw incident log", "redact restricted fields", "build external customer update", "keep allowed diagnostic context"],
    },
    request_match: {
      mentions_codebase: ["repo", "code", "test", "bug"].some((w) => request.toLowerCase().includes(w)),
      mentions_documentation: ["doc", "policy", "readme"].some((w) => request.toLowerCase().includes(w)),
    },
  };
}

export function runCodebaseDemo(request = "", repoPath?: string): Record<string, unknown> {
  const repo = repoPath ?? process.env.GOALCHAINER_CODEBASE_DEMO_REPO ?? DEFAULT_DEMO_REPO;
  regenerateDemoRepo(repo);
  const initialCommit = git(repo, "rev-parse", "--short", "HEAD").stdout.trim();
  const preTests = runTests(repo);
  const contract = inspectDemoRepo(repo);
  const reasoning = analyzeDemoRepo(repo, request, contract);
  write(join(repo, "src/updateBuilder.mjs"), fixedBuilder(contract));
  const patchDiff = git(repo, "diff", "--", "src/updateBuilder.mjs").stdout;
  const postTests = runTests(repo);
  const postContract = inspectDemoRepo(repo);
  git(repo, "add", "src/updateBuilder.mjs");
  git(repo, "commit", "-q", "-m", "Fix customer update redaction");
  const fixedCommit = git(repo, "rev-parse", "--short", "HEAD").stdout.trim();
  return {
    skill: "goalchainer-codebase-demo",
    request: request.split(/\s+/).filter(Boolean).join(" "),
    repo_path: repo,
    issue: { title: "Customer update leaks restricted checkout incident data", file: "ISSUE.md" },
    workflow: [
      "regenerate local buggy repo",
      "run failing tests",
      "read docs, tests, and implementation",
      "emit HyperBase-ready propositions",
      "rank the root cause and patch plan",
      "apply fix and rerun tests",
    ],
    initial_commit: initialCommit,
    fixed_commit: fixedCommit,
    pre_patch_tests: preTests,
    reasoning,
    patch: { files_changed: ["src/updateBuilder.mjs"], diff: patchDiff },
    post_patch_tests: postTests,
    post_patch_contract: postContract,
    success: preTests.exit_code !== 0 && postTests.exit_code === 0,
    git_log: git(repo, "log", "--oneline", "-2").stdout.trim().split("\n"),
  };
}
