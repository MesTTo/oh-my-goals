import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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
    "metta",
    "assets",
    "skills",
    "ARCHITECTURE.md",
    "README.md",
    "LICENSE",
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
    "bibliography",
    "candidates",
    "cli",
    "core",
    "deontic",
    "directive",
    "durable_store",
    "embedding",
    "execute",
    "explain",
    "extractor",
    "hyperbase",
    "index",
    "ingest",
    "input",
    "json",
    "mcp",
    "mcp_installer",
    "memory",
    "models",
    "metta",
    "metta_bulk",
    "motivation",
    "native_score",
    "pln",
    "prolog",
    "prolog_runtime",
    "query",
    "reasoner",
    "records",
    "research",
    "research_worker",
    "rounding",
    "score",
    "semantic",
    "semantic_memory",
    "skill_installer",
    "snars",
    "solve",
    "subprocess_worker",
    "transformers_embedding",
    "truth_value",
    "vector_index",
  ];
  const allowedFiles = new Set([
    "README.md",
    "ARCHITECTURE.md",
    "LICENSE",
    "package.json",
    "assets/gc_directive.pl",
    "assets/gc_score.pl",
    "assets/hb_worker.py",
    "assets/research_worker.py",
    "metta/oh-my-goals.metta",
    "skills/oh-my-goals/SKILL.md",
    "skills/oh-my-goals/references/input-schema.md",
    "skills/oh-my-goals/agents/openai.yaml",
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
    "dist/metta_bulk.js",
    "dist/metta_bulk.d.ts",
    "dist/prolog.js",
    "dist/skill_installer.js",
    "assets/gc_directive.pl",
    "assets/gc_score.pl",
    "assets/hb_worker.py",
    "assets/research_worker.py",
    "metta/oh-my-goals.metta",
    "skills/oh-my-goals/SKILL.md",
    "skills/oh-my-goals/references/input-schema.md",
    "skills/oh-my-goals/agents/openai.yaml",
    "ARCHITECTURE.md",
    "README.md",
    "LICENSE",
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
    JSON.stringify({ name: "oh-my-goals-package-consumer", version: "1.0.0", private: true }),
  );
  run(NPM, ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  writeFileSync(
    join(consumer, "consumer.ts"),
    [
      'import type { DecisionRanking } from "oh-my-goals";',
      "declare const ranking: DecisionRanking;",
      "const allowed: boolean = ranking.automaticExecutionAllowed;",
      "void allowed;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    process.execPath,
    [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumer,
  );

  const installedMetta = join(
    consumer,
    "node_modules",
    "oh-my-goals",
    "metta",
    "oh-my-goals.metta",
  );
  const scoreProgram = `
    const { scoreActions } = await import("oh-my-goals");
    process.stdout.write(JSON.stringify(scoreActions([["permitted", 0, 0, 1]])));
  `;
  const readInstalledScore = () => {
    const result = run(process.execPath, ["--input-type=module", "--eval", scoreProgram], consumer);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const pristineMetta = readFileSync(installedMetta, "utf8");
  const scoreCoefficient = "(* 0.54 $motivation)";
  assert.equal(
    pristineMetta.split(scoreCoefficient).length,
    2,
    "packaged score coefficient is missing or ambiguous",
  );
  assert.deepEqual(readInstalledScore(), [0.54]);
  try {
    writeFileSync(installedMetta, pristineMetta.replace(scoreCoefficient, "(* 0.0 $motivation)"));
    assert.deepEqual(
      readInstalledScore(),
      [0],
      "installed scoreActions did not execute the packaged MeTTa source",
    );
  } finally {
    writeFileSync(installedMetta, pristineMetta);
  }
  assert.deepEqual(readInstalledScore(), [0.54], "packaged MeTTa source was not restored");

  const serializedInput = JSON.stringify(neutralInput());
  const apiProgram = `
    const m = await import("oh-my-goals");
    const input = ${serializedInput};
    const run = m.runGoalChainer(input);
    if (run.selected.actionId !== "verified-action") process.exit(10);
    if (!run.automaticExecutionAllowed) process.exit(14);
    if (typeof m.checkDirectivePrologParity !== "function") process.exit(12);
    if (typeof m.installAgentSkill !== "function") process.exit(13);
    if (typeof m.createMemoryMcpServer !== "function") process.exit(15);
    if (typeof m.runStdioMemoryServer !== "function") process.exit(16);
  `;
  const api = run(process.execPath, ["--input-type=module", "--eval", apiProgram], consumer);
  assert.equal(api.stderr, "");

  const executable = (name) =>
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  const primary = executable("oh-my-goals");
  const compatibilityAliases = [executable("goalchainer"), executable("goalchainer-ts")];
  for (const alias of compatibilityAliases) {
    assert.equal(existsSync(alias), true, `compatibility CLI alias is missing: ${alias}`);
  }
  const inputPath = join(consumer, "input.json");
  writeFileSync(inputPath, serializedInput);

  for (const bin of [primary, ...compatibilityAliases]) {
    const decision = run(bin, ["decide", "--input", inputPath], consumer);
    const decisionPayload = JSON.parse(decision.stdout);
    assert.equal(decisionPayload.selected, "verified-action");
    assert.equal(decisionPayload.status, "recommended");
    assert.equal(decisionPayload.automatic_execution_allowed, true);
  }

  const stdin = run(primary, ["decide", "--input", "-"], consumer, 0, serializedInput);
  assert.equal(JSON.parse(stdin.stdout).selected, "verified-action");
  assert.match(run(primary, ["unknown"], consumer, 2).stderr, /unknown command/);
  assert.match(run(primary, ["decide", "--input", "-"], consumer, 2, "{").stderr, /invalid JSON/);

  const paths = {
    codex: [".agents", "skills", "oh-my-goals"],
    claude: [".claude", "skills", "oh-my-goals"],
    opencode: [".opencode", "skills", "oh-my-goals"],
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
    assert.match(readFileSync(join(project, ...segments, "SKILL.md"), "utf8"), /name: oh-my-goals/);
  }

  // The MCP-registration installer writes a launchable server entry per agent
  // format, is idempotent, and reverses cleanly.
  const mcpProject = join(consumer, "project-mcp");
  mkdirSync(mcpProject);
  const registered = JSON.parse(
    run(primary, ["install-mcp", "--agent", "all", "--project-root", mcpProject], consumer).stdout,
  );
  assert.equal(registered.registered.length, 2, "install-mcp --agent all registers codex and claude");
  const claudeEntry = JSON.parse(readFileSync(join(mcpProject, ".mcp.json"), "utf8")).mcpServers[
    "oh-my-goals"
  ];
  assert.equal(claudeEntry.type, "stdio");
  assert.equal(typeof claudeEntry.command, "string");
  assert.equal(claudeEntry.args.at(-1), "mcp", "registered server launches the mcp subcommand");
  assert(claudeEntry.args.some((arg) => arg.endsWith("cli.js")), "registered server runs the packaged CLI");
  assert.match(readFileSync(join(mcpProject, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.oh-my-goals\]/);
  const reRegistered = JSON.parse(
    run(primary, ["install-mcp", "--agent", "all", "--project-root", mcpProject], consumer).stdout,
  );
  assert.equal(reRegistered.registered.length, 0, "install-mcp is idempotent");
  assert.equal(reRegistered.unchanged.length, 2);
  run(primary, ["install-mcp", "--agent", "opencode", "--project-root", mcpProject], consumer);
  assert.equal(
    JSON.parse(readFileSync(join(mcpProject, "opencode.json"), "utf8")).mcp["oh-my-goals"].type,
    "local",
  );
  const removed = JSON.parse(
    run(primary, ["install-mcp", "--agent", "opencode", "--project-root", mcpProject, "--remove"], consumer).stdout,
  );
  assert.equal(removed.removed.length, 1, "install-mcp --remove deregisters our entry");
  assert.equal(
    JSON.parse(readFileSync(join(mcpProject, "opencode.json"), "utf8")).mcp["oh-my-goals"],
    undefined,
  );

  // The combined install writes both the Agent Skill and the MCP registration.
  const bothProject = join(consumer, "project-install");
  mkdirSync(bothProject);
  const both = JSON.parse(
    run(primary, ["install", "--agent", "claude", "--project-root", bothProject], consumer).stdout,
  );
  assert.equal(both.skill.installed.length, 1);
  assert.equal(both.mcp.registered.length, 1);
  assert.match(
    readFileSync(join(bothProject, ".claude", "skills", "oh-my-goals", "SKILL.md"), "utf8"),
    /name: oh-my-goals/,
  );
  assert(
    JSON.parse(readFileSync(join(bothProject, ".mcp.json"), "utf8")).mcpServers["oh-my-goals"],
    "combined install registers the MCP server",
  );

  if (spawnSync("swipl", ["--version"], { encoding: "utf8" }).status === 0) {
    const parity = run(primary, ["prolog-check"], consumer);
    assert.equal(JSON.parse(parity.stdout).passed, true);
  }

  console.log(
    `package smoke passed: ${packResult.files.length} files, native MeTTa, API, bins, assets, and skills verified`,
  );
} finally {
  rmSync(auditRoot, { recursive: true, force: true });
}
