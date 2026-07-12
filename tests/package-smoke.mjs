import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const TEMP_PARENT = join(ROOT, "ai-tmp");

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
assert.equal(manifest.main, "./dist/index.js");
assert.equal(manifest.types, "./dist/index.d.ts");
assert.equal(
  lockfile.packages[""].license,
  manifest.license,
  "package-lock root license differs from package.json",
);

function run(command, args, cwd, expectedStatus = 0, input) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_dry_run: "false" },
  });
  assert.equal(
    result.status,
    expectedStatus,
    [
      `${command} ${args.join(" ")} exited ${result.status}, expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return result;
}

function neutralInput() {
  return {
    scenario: {
      title: "Choose a verified action",
      goals: [
        {
          id: "preserve-contract",
          owner: "maintainers",
          statement: "Preserve the public contract",
          weight: 1,
          kind: "collective",
          required: true,
        },
      ],
      norms: [],
      actions: [
        {
          id: "verified-action",
          label: "Verified action",
          description: "Apply the action with passing checks",
          satisfies: ["preserve-contract"],
        },
      ],
    },
    evidence: {
      "verified-action": {
        strength: 0.9,
        confidence: 0.95,
        source: "package acceptance check",
      },
    },
  };
}

mkdirSync(TEMP_PARENT, { recursive: true });
const auditRoot = mkdtempSync(join(TEMP_PARENT, "package-smoke-"));
const source = join(auditRoot, "source");
const packs = join(auditRoot, "packs");
const consumer = join(auditRoot, "consumer");

try {
  mkdirSync(source);
  mkdirSync(packs);
  mkdirSync(consumer);
  for (const path of [
    "src",
    "assets",
    "skills",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    cpSync(join(ROOT, path), join(source, path), { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(source, "node_modules"), "dir");

  mkdirSync(join(source, "dist"));
  writeFileSync(join(source, "dist", "stale.js"), "throw new Error('stale output');\n");

  const packed = run(NPM, ["pack", "--json", "--pack-destination", packs], source);
  const packResult = JSON.parse(packed.stdout)[0];
  const files = new Map(packResult.files.map((file) => [file.path, file]));
  const moduleStems = [
    "cli",
    "core",
    "deontic",
    "directive",
    "engine",
    "execute",
    "explain",
    "hyperbase",
    "index",
    "input",
    "json",
    "models",
    "motivation",
    "native_score",
    "ontology",
    "pln",
    "prolog",
    "prolog_runtime",
    "reasoner",
    "records",
    "score",
    "skill_installer",
    "snars",
    "truth_value",
  ];
  const allowedFiles = new Set([
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "assets/data-colore.metta",
    "assets/gc_directive.pl",
    "assets/gc_score.pl",
    "skills/goalchainer/SKILL.md",
    "skills/goalchainer/references/input-schema.md",
    "skills/goalchainer/agents/openai.yaml",
    ...moduleStems.flatMap((stem) => [
      `dist/${stem}.js`,
      `dist/${stem}.js.map`,
      `dist/${stem}.d.ts`,
    ]),
  ]);
  assert.deepEqual(
    [...files.keys()].sort(),
    [...allowedFiles].sort(),
    "package file surface differs from the reviewed allowlist",
  );
  assert.equal(
    files.get("dist/cli.js").mode & 0o111,
    0o111,
    "packaged CLI is not executable",
  );
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli.js",
    "dist/prolog.js",
    "dist/skill_installer.js",
    "assets/data-colore.metta",
    "assets/gc_directive.pl",
    "assets/gc_score.pl",
    "skills/goalchainer/SKILL.md",
    "skills/goalchainer/references/input-schema.md",
    "skills/goalchainer/agents/openai.yaml",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
  ]) {
    assert(files.has(required), `package is missing ${required}`);
  }
  assert(!files.has("dist/stale.js"), "prepack retained stale output");
  assert.equal(readFileSync(join(source, "dist", "cli.js"), "utf8").split("\n")[0], "#!/usr/bin/env node");
  const sourceMap = JSON.parse(readFileSync(join(source, "dist", "core.js.map"), "utf8"));
  assert.equal(sourceMap.sources.length, 1);
  assert.equal(sourceMap.sourcesContent.length, 1);
  assert.match(sourceMap.sourcesContent[0], /export function evaluateScenario/);

  const tarball = resolve(packs, packResult.filename);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "goalchainer-package-consumer", version: "1.0.0", private: true }),
  );
  run(NPM, ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], consumer);

  const serializedInput = JSON.stringify(neutralInput());
  const apiProgram = `
    const m = await import("goalchainer-ts");
    const input = ${serializedInput};
    const run = m.runGoalChainer(input);
    const ontology = m.loadColoreContext();
    if (run.selected.actionId !== "verified-action") process.exit(10);
    if (!run.automaticExecutionAllowed) process.exit(14);
    if (!ontology.source_available) process.exit(11);
    if (typeof m.checkDirectivePrologParity !== "function") process.exit(12);
    if (typeof m.installAgentSkill !== "function") process.exit(13);
  `;
  const api = run(process.execPath, ["--input-type=module", "--eval", apiProgram], consumer);
  assert.equal(api.stderr, "");

  const executable = (name) =>
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  const primary = executable("goalchainer");
  const alias = executable("goalchainer-ts");
  const inputPath = join(consumer, "input.json");
  writeFileSync(inputPath, serializedInput);

  for (const bin of [primary, alias]) {
    const result = run(bin, ["decide", "--input", inputPath], consumer);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.selected, "verified-action");
    assert.equal(payload.status, "recommended");
    assert.equal(payload.automatic_execution_allowed, true);
  }

  const stdin = run(primary, ["decide", "--input", "-"], consumer, 0, serializedInput);
  assert.equal(JSON.parse(stdin.stdout).selected, "verified-action");
  assert.match(run(primary, ["unknown"], consumer, 2).stderr, /unknown command/);
  assert.match(run(primary, ["decide", "--input", "-"], consumer, 2, "{").stderr, /invalid JSON/);

  const paths = {
    codex: [".agents", "skills", "goalchainer"],
    claude: [".claude", "skills", "goalchainer"],
    opencode: [".opencode", "skills", "goalchainer"],
  };
  for (const [agent, segments] of Object.entries(paths)) {
    const project = join(consumer, `project-${agent}`);
    mkdirSync(project);
    const installed = run(
      primary,
      ["install-skill", "--agent", agent, "--project-root", project],
      consumer,
    );
    assert.equal(JSON.parse(installed.stdout).installed.length, 1);
    assert.match(readFileSync(join(project, ...segments, "SKILL.md"), "utf8"), /name: goalchainer/);
  }

  if (spawnSync("swipl", ["--version"], { encoding: "utf8" }).status === 0) {
    const parity = run(primary, ["prolog-check"], consumer);
    assert.equal(JSON.parse(parity.stdout).passed, true);
  }

  console.log(
    `package smoke passed: ${packResult.files.length} files, API, bins, assets, and skills verified`,
  );
} finally {
  rmSync(auditRoot, { recursive: true, force: true });
}
