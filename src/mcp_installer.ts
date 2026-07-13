// Register the Oh My Goals memory MCP server into a coding agent's local config.
// The Agent Skill teaches the agent how to use the loop; this wires the server so
// the agent can reach it. Three agents keep three formats: Claude Code reads
// `.mcp.json` (JSON, key `mcpServers`), Codex reads `config.toml`
// (`[mcp_servers.<id>]`), and OpenCode reads `opencode.json` (JSON, key `mcp`).
// The formats are confirmed from each project's current documentation.
//
// Registration merges into an existing config without disturbing the user's other
// servers or settings. It is idempotent (an already-correct entry is left byte for
// byte untouched), atomic (staged file renamed over the target), and reversible
// (`remove` deletes only our entry). The TOML path preserves comments by editing a
// single table block. Nothing here reads or copies the agent's authentication.

import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { stableJson } from "./json.js";
import {
  assertDenseArray,
  assertKnownKeys,
  assertOptionalNonblankStrings,
  assertPlainRecord,
} from "./records.js";
import type { AgentTarget } from "./skill_installer.js";

export type McpInstallScope = "project" | "user";
type ConcreteAgent = Exclude<AgentTarget, "all">;
type ConfigFormat = "claude" | "opencode" | "toml";

/** The stdio launch a registered entry runs. The host resolves it once. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpInstallOptions {
  readonly agent: AgentTarget;
  readonly scope: McpInstallScope;
  readonly launch: McpServerLaunch;
  readonly projectRoot?: string;
  readonly homeDir?: string;
  /** Deregister our entry instead of registering it. */
  readonly remove?: boolean;
}

export interface McpInstallResult {
  /** Config files whose entry was written or updated. */
  readonly registered: readonly string[];
  /** Config files whose entry already matched, left untouched. */
  readonly unchanged: readonly string[];
  /** Config files our entry was removed from. */
  readonly removed: readonly string[];
}

const SERVER_ID = "oh-my-goals";
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";
const PROPAGATED_ENV = [
  "OH_MY_GOALS_METTABASE_DIR",
  "OH_MY_GOALS_HYPERBASE_PYTHON",
  "OH_MY_GOALS_EMBEDDING",
] as const;

const CONCRETE_AGENTS = ["codex", "claude", "opencode"] as const;

/** The parser paths and embedding choice to carry into a registered server, taken
 * from the installer's own environment when present. Per-project memory and
 * repository identity come from the server's working directory at runtime, so no
 * machine-specific store path is baked into a shared config. */
export function resolveLaunchEnv(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROPAGATED_ENV) {
    const value = processEnv[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return env;
}

interface ValidatedRequest {
  agent: AgentTarget;
  scope: McpInstallScope;
  launch: McpServerLaunch;
  projectRoot: string;
  homeDir: string;
  remove: boolean;
}

function validateLaunch(value: unknown): McpServerLaunch {
  assertPlainRecord(value, "mcp launch");
  assertKnownKeys(value, "mcp launch", ["command", "args", "env"]);
  if (typeof value.command !== "string" || value.command.trim() === "") {
    throw new TypeError("mcp launch command must be a nonblank string");
  }
  assertDenseArray(value.args, "mcp launch args");
  const args = value.args.map((arg, index) => {
    if (typeof arg !== "string") throw new TypeError(`mcp launch args[${index}] must be a string`);
    return arg;
  });
  assertPlainRecord(value.env, "mcp launch env");
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") throw new TypeError(`mcp launch env.${key} must be a string`);
    env[key] = entry;
  }
  return { command: value.command, args, env };
}

function validateOptions(options: McpInstallOptions): ValidatedRequest {
  assertPlainRecord(options, "mcp installation options");
  assertKnownKeys(options, "mcp installation options", [
    "agent",
    "scope",
    "launch",
    "projectRoot",
    "homeDir",
    "remove",
  ]);
  if (![...CONCRETE_AGENTS, "all"].includes(options.agent)) {
    throw new TypeError(`Unsupported agent target: ${String(options.agent)}`);
  }
  if (options.scope !== "project" && options.scope !== "user") {
    throw new TypeError(`Unsupported mcp installation scope: ${String(options.scope)}`);
  }
  if (options.remove !== undefined && typeof options.remove !== "boolean") {
    throw new TypeError("mcp installation remove must be a boolean");
  }
  assertOptionalNonblankStrings(
    { projectRoot: options.projectRoot, homeDir: options.homeDir },
    "mcp installation",
  );
  return {
    agent: options.agent,
    scope: options.scope,
    launch: validateLaunch(options.launch),
    projectRoot: resolve(options.projectRoot ?? process.cwd()),
    homeDir: resolve(options.homeDir ?? homedir()),
    remove: options.remove === true,
  };
}

function agentsFor(agent: AgentTarget): readonly ConcreteAgent[] {
  return agent === "all" ? ["codex", "claude"] : [agent];
}

function configTarget(
  agent: ConcreteAgent,
  scope: McpInstallScope,
  base: string,
): { path: string; format: ConfigFormat } {
  if (agent === "claude") {
    return scope === "project"
      ? { path: join(base, ".mcp.json"), format: "claude" }
      : { path: join(base, ".claude.json"), format: "claude" };
  }
  if (agent === "codex") {
    return { path: join(base, ".codex", "config.toml"), format: "toml" };
  }
  return scope === "project"
    ? { path: join(base, "opencode.json"), format: "opencode" }
    : { path: join(base, ".config", "opencode", "opencode.json"), format: "opencode" };
}

// --- JSON formats (Claude Code, OpenCode) ---

function claudeEntry(launch: McpServerLaunch): Record<string, unknown> {
  return {
    type: "stdio",
    command: launch.command,
    ...(launch.args.length > 0 ? { args: [...launch.args] } : {}),
    ...(Object.keys(launch.env).length > 0 ? { env: { ...launch.env } } : {}),
  };
}

function opencodeEntry(launch: McpServerLaunch): Record<string, unknown> {
  return {
    type: "local",
    command: [launch.command, ...launch.args],
    enabled: true,
    ...(Object.keys(launch.env).length > 0 ? { environment: { ...launch.env } } : {}),
  };
}

type MergeOutcome =
  | { status: "unchanged" }
  | { status: "registered" | "removed"; text: string };

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `existing config is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`existing config is not a JSON object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function mergeJson(
  raw: string | null,
  path: string,
  containerKey: string,
  entry: Record<string, unknown>,
  remove: boolean,
  schema: string | null,
): MergeOutcome {
  const fresh = raw === null;
  const root = fresh ? {} : parseJsonObject(raw, path);
  const existingContainer = root[containerKey];
  const container =
    existingContainer !== null && typeof existingContainer === "object" && !Array.isArray(existingContainer)
      ? { ...(existingContainer as Record<string, unknown>) }
      : {};

  if (remove) {
    if (!(SERVER_ID in container)) return { status: "unchanged" };
    delete container[SERVER_ID];
    const next = { ...root, [containerKey]: container };
    return { status: "removed", text: `${JSON.stringify(next, null, 2)}\n` };
  }

  if (SERVER_ID in container && stableJson(container[SERVER_ID]) === stableJson(entry)) {
    return { status: "unchanged" };
  }
  container[SERVER_ID] = entry;
  // Seed $schema only when creating the file; never add it to a config the user
  // already keeps without one.
  const next: Record<string, unknown> = fresh && schema !== null ? { $schema: schema } : { ...root };
  next[containerKey] = container;
  return { status: "registered", text: `${JSON.stringify(next, null, 2)}\n` };
}

// --- TOML format (Codex) ---

/** A TOML basic string, escaping the characters the spec requires. */
function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function tomlBlock(launch: McpServerLaunch): string {
  const lines = [`[mcp_servers.${SERVER_ID}]`, `command = ${tomlString(launch.command)}`];
  if (launch.args.length > 0) {
    lines.push(`args = [${launch.args.map(tomlString).join(", ")}]`);
  }
  const envKeys = Object.keys(launch.env);
  if (envKeys.length > 0) {
    const pairs = envKeys.map((key) => `${key} = ${tomlString(launch.env[key]!)}`);
    lines.push(`env = { ${pairs.join(", ")} }`);
  }
  return lines.join("\n");
}

// The [start, end) character span of our table: the header line through the last
// contiguous non-blank line under it, excluding the trailing newline. A blank line
// or the next table header ends the block, so a comment that introduces the
// following table stays with it. `end` is the offset just past the last key line.
function tomlTableSpan(text: string, header: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === header) {
      const start = offset;
      let end = offset + line.length;
      let cursor = end + 1;
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLine = lines[next]!;
        const trimmed = nextLine.trim();
        if (trimmed === "" || trimmed.startsWith("[")) break;
        end = cursor + nextLine.length;
        cursor = end + 1;
      }
      return { start, end };
    }
    offset += line.length + 1;
  }
  return null;
}

function tidyToml(text: string): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  const trimmed = collapsed.replace(/\s*$/, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

function mergeToml(raw: string | null, launch: McpServerLaunch, remove: boolean): MergeOutcome {
  const header = `[mcp_servers.${SERVER_ID}]`;
  const block = tomlBlock(launch);
  const text = raw ?? "";
  const span = tomlTableSpan(text, header);

  if (remove) {
    if (span === null) return { status: "unchanged" };
    const merged = text.slice(0, span.start) + text.slice(span.end);
    return { status: "removed", text: tidyToml(merged) };
  }

  if (span !== null) {
    if (text.slice(span.start, span.end).trim() === block.trim()) {
      return { status: "unchanged" };
    }
    const merged = `${text.slice(0, span.start)}${block}\n${text.slice(span.end)}`;
    return { status: "registered", text: tidyToml(merged) };
  }

  const base = text.replace(/\s*$/, "");
  const merged = base === "" ? block : `${base}\n\n${block}`;
  return { status: "registered", text: `${merged}\n` };
}

function mergeConfig(
  format: ConfigFormat,
  raw: string | null,
  path: string,
  launch: McpServerLaunch,
  remove: boolean,
): MergeOutcome {
  if (format === "toml") return mergeToml(raw, launch, remove);
  if (format === "opencode") {
    return mergeJson(raw, path, "mcp", opencodeEntry(launch), remove, OPENCODE_SCHEMA);
  }
  return mergeJson(raw, path, "mcpServers", claudeEntry(launch), remove, null);
}

// --- filesystem ---

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readConfig(path: string): Promise<{ raw: string | null; mode: number }> {
  const stats = await statIfPresent(path);
  if (stats === undefined) return { raw: null, mode: 0o600 };
  if (stats.isSymbolicLink()) throw new Error(`config path is a symbolic link: ${path}`);
  if (!stats.isFile()) throw new Error(`config path is not a regular file: ${path}`);
  return { raw: await readFile(path, "utf8"), mode: stats.mode & 0o777 };
}

async function writeConfigAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.oh-my-goals-${process.pid}.tmp`;
  await writeFile(staged, text, { mode });
  await chmod(staged, mode);
  await rename(staged, path);
}

/** Register or, with `remove`, deregister the memory MCP server in the selected
 * coding agent's config file(s). Each file is written atomically and independently;
 * a file whose entry already matches is left untouched. */
export async function registerMcpServer(options: McpInstallOptions): Promise<McpInstallResult> {
  const request = validateOptions(options);
  const base = request.scope === "project" ? request.projectRoot : request.homeDir;
  const registered: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  for (const agent of agentsFor(request.agent)) {
    const target = configTarget(agent, request.scope, base);
    const { raw, mode } = await readConfig(target.path);
    const outcome = mergeConfig(target.format, raw, target.path, request.launch, request.remove);
    if (outcome.status === "unchanged") {
      unchanged.push(target.path);
      continue;
    }
    await writeConfigAtomic(target.path, outcome.text, mode);
    (outcome.status === "removed" ? removed : registered).push(target.path);
  }

  return Object.freeze({
    registered: Object.freeze(registered),
    unchanged: Object.freeze(unchanged),
    removed: Object.freeze(removed),
  });
}
