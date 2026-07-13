#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { ZodError } from "zod";

import {
  ContextualEvidenceRequiresReasonerError,
  goalChainerRunToJson,
  runGoalChainer,
} from "./core.js";
import { checkDirectivePrologParity } from "./directive.js";
import { stableJson } from "./json.js";
import { runStdioMemoryServer } from "./mcp.js";
import {
  registerMcpServer,
  resolveLaunchEnv,
  type McpInstallScope,
  type McpServerLaunch,
} from "./mcp_installer.js";
import { verifyScorePrologParity } from "./prolog.js";
import {
  installAgentSkill,
  type AgentTarget,
  type SkillInstallScope,
} from "./skill_installer.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const AGENTS = ["codex", "claude", "opencode", "all"] as const;
const SCOPES = ["project", "user"] as const;

const ROOT_HELP = `usage: oh-my-goals <command> [options]

commands:
  install         install the Agent Skill and register the MCP server
  install-skill   install the shared Agent Skill for coding agents
  install-mcp     register the memory MCP server in an agent's config
  mcp             serve the memory and reasoning MCP over stdio
  decide          rank caller-supplied actions from strict JSON input
  prolog-check    compare MeTTa-TS rules with the packaged Prolog relations

run "oh-my-goals <command> --help" for command options`;

const MCP_HELP = `usage: oh-my-goals mcp

Serves the Oh My Goals memory and reasoning MCP over stdio, for a coding agent to
spawn as a child process. It reads and writes JSON-RPC on stdin and stdout.

environment:
  OH_MY_GOALS_MEMORY_DB          durable store path (default: ./.oh-my-goals/memory.db)
  OH_MY_GOALS_REPOSITORY         project identity (default: current directory name)
  OH_MY_GOALS_SESSION            session identity for session-scoped memory
  OH_MY_GOALS_EMBEDDING          "BGE" for the contextual provider (default: token-hash)
  OH_MY_GOALS_METTABASE_DIR      mettabase checkout for the HyperBase parser
  OH_MY_GOALS_HYPERBASE_PYTHON   the parser's Python interpreter

options:
  -h, --help   show this help`;

const DECIDE_HELP = `usage: oh-my-goals decide --input <path|-> [--pretty]

options:
  -i, --input <path|->   read up to 2097152 bytes of strict JSON from a file or stdin
      --pretty           indent JSON output
  -h, --help             show this help`;

const INSTALL_HELP = `usage: oh-my-goals install-skill [options]

options:
      --agent <name>        codex, claude, opencode, or all (default: all)
      --scope <scope>       project or user (default: project)
      --project-root <path> project destination root (default: current directory)
      --force               replace a conflicting existing skill
      --pretty              indent JSON output
  -h, --help                show this help`;

const INSTALL_MCP_HELP = `usage: oh-my-goals install-mcp [options]

Registers the memory MCP server in a coding agent's local config, merging into an
existing config without disturbing other servers. The server launches this same
CLI (node <cli> mcp). Parser paths (OH_MY_GOALS_METTABASE_DIR,
OH_MY_GOALS_HYPERBASE_PYTHON) and OH_MY_GOALS_EMBEDDING are carried over from the
current environment when set; per-project memory and identity come from the
server's working directory at runtime.

options:
      --agent <name>        codex, claude, opencode, or all (default: all)
      --scope <scope>       project or user (default: project)
      --project-root <path> project destination root (default: current directory)
      --remove              deregister our entry instead of adding it
      --pretty              indent JSON output
  -h, --help                show this help`;

const INSTALL_ALL_HELP = `usage: oh-my-goals install [options]

Installs the Agent Skill and registers the memory MCP server in one step, for the
same agent and scope. Equivalent to running install-skill then install-mcp. To
undo, run "install-mcp --remove" and delete the installed skill directory.

options:
      --agent <name>        codex, claude, opencode, or all (default: all)
      --scope <scope>       project or user (default: project)
      --project-root <path> project destination root (default: current directory)
      --force               replace a conflicting existing skill
      --pretty              indent JSON output
  -h, --help                show this help`;

const PROLOG_HELP = `usage: oh-my-goals prolog-check [--pretty]

options:
      --pretty   indent JSON output
  -h, --help     show this help`;

interface CliIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

const CONSOLE_IO: CliIO = {
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

class CliUsageError extends Error {}
class CliInputError extends Error {}

type CliCommand =
  | { kind: "help" }
  | { kind: "decide"; input: string; pretty: boolean; help: boolean }
  | {
      kind: "install-skill";
      agent: AgentTarget;
      scope: SkillInstallScope;
      projectRoot: string;
      force: boolean;
      pretty: boolean;
      help: boolean;
    }
  | {
      kind: "install-mcp";
      agent: AgentTarget;
      scope: McpInstallScope;
      projectRoot: string;
      remove: boolean;
      pretty: boolean;
      help: boolean;
    }
  | {
      kind: "install";
      agent: AgentTarget;
      scope: SkillInstallScope;
      projectRoot: string;
      force: boolean;
      pretty: boolean;
      help: boolean;
    }
  | { kind: "prolog-check"; pretty: boolean; help: boolean }
  | { kind: "mcp"; help: boolean };

function parsed(args: string[], options: ParseArgsConfig["options"]): Record<string, unknown> {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CliUsageError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// The flags shared by install, install-skill, and install-mcp. Each command adds
// its own boolean (force or remove).
const INSTALL_OPTIONS = {
  agent: { type: "string", default: "all" },
  scope: { type: "string", default: "project" },
  "project-root": { type: "string" },
  pretty: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

function installCommon(values: Record<string, unknown>): {
  agent: AgentTarget;
  scope: SkillInstallScope;
  projectRoot: string;
  pretty: boolean;
} {
  return {
    agent: member(values.agent, AGENTS, "--agent"),
    scope: member(values.scope, SCOPES, "--scope"),
    projectRoot: resolve(
      values["project-root"] === undefined ? process.cwd() : String(values["project-root"]),
    ),
    pretty: values.pretty === true,
  };
}

function parseCli(argv: string[]): CliCommand {
  if (argv.length === 0 || (argv.length === 1 && ["-h", "--help"].includes(argv[0]!))) {
    return { kind: "help" };
  }
  const [command, ...args] = argv;
  if (command === "decide") {
    const values = parsed(args, {
      input: { type: "string", short: "i" },
      pretty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    });
    if (values.help === true) return { kind: "decide", input: "", pretty: false, help: true };
    if (typeof values.input !== "string" || values.input === "") {
      throw new CliUsageError("decide requires --input <path|->");
    }
    return { kind: "decide", input: values.input, pretty: values.pretty === true, help: false };
  }
  if (command === "install-skill" || command === "install") {
    const values = parsed(args, { ...INSTALL_OPTIONS, force: { type: "boolean" } });
    if (values.help === true) {
      const help = { agent: "all" as const, scope: "project" as const, projectRoot: process.cwd(), force: false, pretty: false, help: true };
      return command === "install" ? { kind: "install", ...help } : { kind: "install-skill", ...help };
    }
    const common = { ...installCommon(values), force: values.force === true, help: false };
    return command === "install" ? { kind: "install", ...common } : { kind: "install-skill", ...common };
  }
  if (command === "install-mcp") {
    const values = parsed(args, { ...INSTALL_OPTIONS, remove: { type: "boolean" } });
    if (values.help === true) {
      return { kind: "install-mcp", agent: "all", scope: "project", projectRoot: process.cwd(), remove: false, pretty: false, help: true };
    }
    return { kind: "install-mcp", ...installCommon(values), remove: values.remove === true, help: false };
  }
  if (command === "prolog-check") {
    const values = parsed(args, {
      pretty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    });
    return { kind: "prolog-check", pretty: values.pretty === true, help: values.help === true };
  }
  if (command === "mcp") {
    const values = parsed(args, { help: { type: "boolean", short: "h" } });
    return { kind: "mcp", help: values.help === true };
  }
  throw new CliUsageError(`unknown command: ${String(command)}`);
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_INPUT_BYTES) {
      throw new CliInputError(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function readRegularFile(path: string): Buffer {
  const stat = statSync(path);
  if (!stat.isFile()) throw new CliInputError(`input is not a regular file: ${path}`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new CliInputError(`input exceeds ${MAX_INPUT_BYTES} bytes: ${path}`);
  }

  const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
  const descriptor = openSync(path, "r");
  let size = 0;
  try {
    while (size < buffer.byteLength) {
      const read = readSync(descriptor, buffer, size, buffer.byteLength - size, null);
      if (read === 0) break;
      size += read;
    }
  } finally {
    closeSync(descriptor);
  }
  if (size > MAX_INPUT_BYTES) {
    throw new CliInputError(`input exceeds ${MAX_INPUT_BYTES} bytes: ${path}`);
  }
  return buffer.subarray(0, size);
}

async function readInput(path: string): Promise<unknown> {
  let raw: Buffer;
  try {
    if (path === "-") raw = await readStdin();
    else raw = readRegularFile(path);
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError(
      `cannot read input ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw.byteLength > MAX_INPUT_BYTES) {
    throw new CliInputError(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new CliInputError(
      `input is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliInputError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function inputError(error: unknown): string | null {
  if (error instanceof CliInputError) return error.message;
  if (error instanceof ContextualEvidenceRequiresReasonerError) return error.message;
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("\n");
  }
  return null;
}

// The stdio launch a registered MCP entry runs: this same CLI, under the current
// node, serving over stdio. Parser paths and embedding choice ride along from the
// environment; per-project memory comes from the server's working directory.
function memoryServerLaunch(): McpServerLaunch {
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "mcp"],
    env: resolveLaunchEnv(process.env),
  };
}

async function run(command: CliCommand, io: CliIO): Promise<number> {
  if (command.kind === "help") {
    io.stdout(ROOT_HELP);
    return 0;
  }
  if (command.help) {
    const help: Record<string, string> = {
      decide: DECIDE_HELP,
      install: INSTALL_ALL_HELP,
      "install-skill": INSTALL_HELP,
      "install-mcp": INSTALL_MCP_HELP,
      mcp: MCP_HELP,
      "prolog-check": PROLOG_HELP,
    };
    io.stdout(help[command.kind] ?? ROOT_HELP);
    return 0;
  }
  if (command.kind === "mcp") {
    // Serve JSON-RPC on stdio; the transport owns stdout, so write nothing else to
    // it. The process stays alive on the stdin listener until the client closes it.
    const repository = process.env.OH_MY_GOALS_REPOSITORY ?? basename(process.cwd());
    const storePath = process.env.OH_MY_GOALS_MEMORY_DB ?? join(process.cwd(), ".oh-my-goals", "memory.db");
    mkdirSync(dirname(storePath), { recursive: true });
    const session = process.env.OH_MY_GOALS_SESSION;
    await runStdioMemoryServer({
      repository,
      storePath,
      ...(session !== undefined && session !== "" ? { session } : {}),
    });
    return 0;
  }
  if (command.kind === "decide") {
    const result = goalChainerRunToJson(runGoalChainer(await readInput(command.input)));
    io.stdout(stableJson(result, command.pretty));
    return 0;
  }
  if (command.kind === "install-skill") {
    const result = await installAgentSkill({
      agent: command.agent,
      scope: command.scope,
      projectRoot: command.projectRoot,
      homeDir: homedir(),
      force: command.force,
    });
    io.stdout(stableJson(result, command.pretty));
    return 0;
  }
  if (command.kind === "install-mcp") {
    const result = await registerMcpServer({
      agent: command.agent,
      scope: command.scope,
      launch: memoryServerLaunch(),
      projectRoot: command.projectRoot,
      homeDir: homedir(),
      remove: command.remove,
    });
    io.stdout(stableJson(result, command.pretty));
    return 0;
  }
  if (command.kind === "install") {
    const skill = await installAgentSkill({
      agent: command.agent,
      scope: command.scope,
      projectRoot: command.projectRoot,
      homeDir: homedir(),
      force: command.force,
    });
    const mcp = await registerMcpServer({
      agent: command.agent,
      scope: command.scope,
      launch: memoryServerLaunch(),
      projectRoot: command.projectRoot,
      homeDir: homedir(),
    });
    io.stdout(stableJson({ skill, mcp }, command.pretty));
    return 0;
  }

  const scoreRows = [
    ["forbidden", 1, 1, 1, 0],
    ["conflict", 1, 1, 1, 0],
    ["obligated", 0.9, 0.8, 1, 0],
    ["permitted", 1, 1, 0.4, 0],
    ["permitted", 1, 1, 1, 1],
    ["unregulated", 0, 0, 0, 0],
  ] as const;
  const [score, directive] = await Promise.all([
    verifyScorePrologParity(scoreRows),
    checkDirectivePrologParity(),
  ]);
  const passed = score.passed && directive.matches;
  io.stdout(stableJson({ passed, score, directive }, command.pretty));
  return passed ? 0 : 1;
}

export async function main(argv: string[], io: CliIO = CONSOLE_IO): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    io.stderr(`oh-my-goals: ${error.message}\n\n${ROOT_HELP}`);
    return 2;
  }
  try {
    return await run(command, io);
  } catch (error) {
    const message = inputError(error);
    if (message !== null) {
      io.stderr(`oh-my-goals: invalid input\n${message}`);
      return 2;
    }
    io.stderr(`oh-my-goals: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
