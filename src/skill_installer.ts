import { constants as fsConstants } from "node:fs";
import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnownKeys, assertPlainRecord } from "./records.js";

export type AgentTarget = "codex" | "claude" | "opencode" | "all";

export type SkillInstallScope = "project" | "user";

export interface SkillInstallOptions {
  agent: AgentTarget;
  scope: SkillInstallScope;
  projectRoot?: string;
  homeDir?: string;
  force?: boolean;
}

export interface SkillInstallResult {
  installed: readonly string[];
  unchanged: readonly string[];
}

type ConcreteAgentTarget = Exclude<AgentTarget, "all">;

interface TreeDirectory {
  path: string;
  mode: number;
}

interface TreeFile {
  path: string;
  mode: number;
  contents: Buffer;
}

interface TreeSnapshot {
  rootMode: number;
  directories: readonly TreeDirectory[];
  files: readonly TreeFile[];
}

type DestinationSnapshot =
  | { kind: "missing" }
  | { kind: "directory"; tree: TreeSnapshot }
  | { kind: "file"; contents: Buffer; mode: number };

interface TargetPlan {
  path: string;
  base: string;
  expected: DestinationSnapshot;
  action: "install" | "replace" | "unchanged";
}

interface CompletedPlan {
  plan: TargetPlan;
  backupRoot?: string;
  backupPath?: string;
  cleanupRoots: readonly string[];
  createdParents: readonly string[];
}

const CANONICAL_SKILL_ROOT = resolve(
  fileURLToPath(new URL("../skills/goalchainer/", import.meta.url)),
);

const CONCRETE_TARGETS = ["codex", "claude", "opencode"] as const;

const MAX_SNAPSHOT_FILES = 128;
const MAX_SNAPSHOT_DIRECTORIES = 64;
const MAX_SNAPSHOT_DEPTH = 16;
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;

const TARGET_SEGMENTS = {
  project: {
    codex: [".agents", "skills", "goalchainer"],
    claude: [".claude", "skills", "goalchainer"],
    opencode: [".opencode", "skills", "goalchainer"],
  },
  user: {
    codex: [".agents", "skills", "goalchainer"],
    claude: [".claude", "skills", "goalchainer"],
    opencode: [".config", "opencode", "skills", "goalchainer"],
  },
} as const satisfies Record<
  SkillInstallScope,
  Record<ConcreteAgentTarget, readonly string[]>
>;

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertContained(base: string, candidate: string): void {
  const relativePath = relative(base, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Skill destination escapes its installation root: ${candidate}`);
  }
}

async function readRegularFile(path: string, description: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new Error(`${description} contains a symbolic link: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${description} contains a non-regular file: ${path}`);
    }
    if (stats.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(
        `${description} file exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes: ${path}`,
      );
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let observedGrowth = false;
    while (bytesRead <= MAX_SNAPSHOT_FILE_BYTES) {
      const remaining = MAX_SNAPSHOT_FILE_BYTES + 1 - bytesRead;
      const expectedRemaining = Math.max(1, stats.size - bytesRead + 1);
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, remaining, observedGrowth ? remaining : expectedRemaining),
      );
      const result = await handle.read(
        chunk,
        0,
        chunk.length,
        null,
      );
      if (result.bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
      bytesRead += result.bytesRead;
      if (bytesRead > stats.size) observedGrowth = true;
    }
    if (bytesRead > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(
        `${description} file exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes: ${path}`,
      );
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesRead);
  } finally {
    await handle.close();
  }
}

async function snapshotTree(root: string, description: string): Promise<TreeSnapshot> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`${description} is a symbolic link: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`${description} is not a directory: ${root}`);
  }

  const directories: TreeDirectory[] = [];
  const files: TreeFile[] = [];
  let totalBytes = 0;

  async function walk(
    directory: string,
    directoryPath: string,
    depth: number,
  ): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const child = join(directory, entry.name);
      const childPath = directoryPath
        ? join(directoryPath, entry.name)
        : entry.name;
      assertContained(root, child);

      const stats = await lstat(child);
      if (stats.isSymbolicLink()) {
        throw new Error(`${description} contains a symbolic link: ${child}`);
      }
      if (stats.isDirectory()) {
        if (depth + 1 > MAX_SNAPSHOT_DEPTH) {
          throw new Error(
            `${description} exceeds the maximum directory depth of ${MAX_SNAPSHOT_DEPTH}: ${child}`,
          );
        }
        if (directories.length >= MAX_SNAPSHOT_DIRECTORIES) {
          throw new Error(
            `${description} exceeds the maximum of ${MAX_SNAPSHOT_DIRECTORIES} directories`,
          );
        }
        directories.push({ path: childPath, mode: stats.mode & 0o777 });
        await walk(child, childPath, depth + 1);
        continue;
      }
      if (stats.isFile()) {
        if (files.length >= MAX_SNAPSHOT_FILES) {
          throw new Error(
            `${description} exceeds the maximum of ${MAX_SNAPSHOT_FILES} files`,
          );
        }
        const contents = await readRegularFile(child, description);
        totalBytes += contents.length;
        if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
          throw new Error(
            `${description} exceeds ${MAX_SNAPSHOT_TOTAL_BYTES} total file bytes`,
          );
        }
        files.push({
          path: childPath,
          mode: stats.mode & 0o777,
          contents,
        });
        continue;
      }
      throw new Error(`${description} contains a non-regular entry: ${child}`);
    }
  }

  await walk(root, "", 0);
  directories.sort((left, right) => left.path.localeCompare(right.path));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    rootMode: rootStats.mode & 0o777,
    directories,
    files,
  };
}

function treesEqual(left: TreeSnapshot, right: TreeSnapshot): boolean {
  if (
    left.rootMode !== right.rootMode ||
    left.directories.length !== right.directories.length ||
    left.files.length !== right.files.length
  ) {
    return false;
  }

  for (let index = 0; index < left.directories.length; index += 1) {
    if (
      left.directories[index]!.path !== right.directories[index]!.path ||
      left.directories[index]!.mode !== right.directories[index]!.mode
    ) {
      return false;
    }
  }

  for (let index = 0; index < left.files.length; index += 1) {
    const leftFile = left.files[index]!;
    const rightFile = right.files[index]!;
    if (
      leftFile.path !== rightFile.path ||
      leftFile.mode !== rightFile.mode ||
      !leftFile.contents.equals(rightFile.contents)
    ) {
      return false;
    }
  }

  return true;
}

async function inspectDestination(path: string): Promise<DestinationSnapshot> {
  const stats = await lstatIfPresent(path);
  if (!stats) return { kind: "missing" };
  if (stats.isSymbolicLink()) {
    throw new Error(`Skill destination is a symbolic link: ${path}`);
  }
  if (stats.isDirectory()) {
    return {
      kind: "directory",
      tree: await snapshotTree(path, "Skill destination"),
    };
  }
  if (stats.isFile()) {
    return {
      kind: "file",
      contents: await readRegularFile(path, "Skill destination"),
      mode: stats.mode & 0o777,
    };
  }
  throw new Error(`Skill destination is neither a directory nor a regular file: ${path}`);
}

function destinationSnapshotsEqual(
  left: DestinationSnapshot,
  right: DestinationSnapshot,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.contents.equals(right.contents);
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return treesEqual(left.tree, right.tree);
  }
  return false;
}

async function inspectSafeParentPath(
  base: string,
  parent: string,
  create: boolean,
): Promise<string[]> {
  assertContained(base, parent);
  const baseStats = await lstatIfPresent(base);
  if (!baseStats) {
    throw new Error(`Skill installation root does not exist: ${base}`);
  }
  if (baseStats.isSymbolicLink()) {
    throw new Error(`Skill installation root is a symbolic link: ${base}`);
  }
  if (!baseStats.isDirectory()) {
    throw new Error(`Skill installation root is not a directory: ${base}`);
  }

  const parentPath = relative(base, parent);
  if (!parentPath) return [];

  const created: string[] = [];
  let current = base;
  try {
    for (const segment of parentPath.split(sep)) {
      current = join(current, segment);
      let stats = await lstatIfPresent(current);
      if (!stats && create) {
        try {
          await mkdir(current);
          created.push(current);
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
        stats = await lstatIfPresent(current);
      }
      if (!stats) {
        if (create) {
          throw new Error(`Failed to create skill destination parent: ${current}`);
        }
        break;
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Skill destination parent is a symbolic link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Skill destination parent is not a directory: ${current}`);
      }
    }
    return created;
  } catch (pathError) {
    const cleanupErrors = await removeCreatedParents(created);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [pathError, ...cleanupErrors],
        "Skill destination parent validation failed and created directories could not be removed",
      );
    }
    throw pathError;
  }
}

async function removeCreatedParents(paths: readonly string[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const path of [...paths].reverse()) {
    try {
      await rmdir(path);
    } catch (error) {
      if (
        !hasErrorCode(error, "ENOENT") &&
        !hasErrorCode(error, "ENOTEMPTY") &&
        !hasErrorCode(error, "EEXIST")
      ) {
        errors.push(error);
      }
    }
  }
  return errors;
}

async function writeSnapshot(root: string, snapshot: TreeSnapshot): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  for (const directory of snapshot.directories) {
    const path = join(root, directory.path);
    await mkdir(path, { mode: 0o700 });
  }
  for (const file of snapshot.files) {
    const path = join(root, file.path);
    await writeFile(path, file.contents, {
      flag: "wx",
      mode: file.mode,
    });
    await chmod(path, file.mode);
  }
  for (const directory of [...snapshot.directories].reverse()) {
    await chmod(join(root, directory.path), directory.mode);
  }
  await chmod(root, snapshot.rootMode);
}

async function makeTreeRemovable(root: string): Promise<void> {
  const stats = await lstatIfPresent(root);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return;

  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeRemovable(join(root, entry.name));
    }
  }
}

async function removePrivateTree(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (firstError) {
    try {
      await makeTreeRemovable(root);
      await rm(root, { recursive: true, force: true });
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        `Failed to remove private installation tree: ${root}`,
      );
    }
  }
}

async function replaceKeepingBackup(
  stagedPath: string,
  destination: string,
  expected: DestinationSnapshot,
): Promise<{ backupRoot: string; backupPath: string }> {
  const parent = dirname(destination);
  const backupRoot = await mkdtemp(join(parent, ".goalchainer-backup-"));
  const backupPath = join(backupRoot, "goalchainer");

  try {
    await rename(destination, backupPath);
  } catch (backupError) {
    try {
      await removePrivateTree(backupRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [backupError, cleanupError],
        `Failed to preserve ${destination}, and the empty backup directory could not be removed: ${backupRoot}`,
      );
    }
    throw backupError;
  }

  try {
    const preserved = await inspectDestination(backupPath);
    if (!destinationSnapshotsEqual(expected, preserved)) {
      throw new Error(`Skill destination changed while it was being preserved: ${destination}`);
    }
  } catch (validationError) {
    try {
      await rename(backupPath, destination);
    } catch (restoreError) {
      throw new AggregateError(
        [validationError, restoreError],
        `The destination changed during installation and could not be restored. Its preserved tree remains at ${backupPath}`,
      );
    }
    try {
      await removePrivateTree(backupRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [validationError, cleanupError],
        `The destination changed during installation. It was restored, but a private installation directory remains at ${backupRoot}`,
      );
    }
    throw validationError;
  }

  try {
    await rename(stagedPath, destination);
  } catch (installError) {
    try {
      await rename(backupPath, destination);
    } catch (rollbackError) {
      throw new AggregateError(
        [installError, rollbackError],
        `Failed to install the skill and restore the previous destination. The previous tree remains at ${backupPath}`,
      );
    }

    try {
      await removePrivateTree(backupRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [installError, cleanupError],
        `Failed to install the skill. The previous destination was restored, but a private installation directory remains at ${backupRoot}`,
      );
    }
    throw installError;
  }

  return { backupRoot, backupPath };
}

async function materializePlan(
  plan: TargetPlan,
  source: TreeSnapshot,
): Promise<CompletedPlan> {
  const parent = dirname(plan.path);
  const createdParents = await inspectSafeParentPath(plan.base, parent, true);
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(join(parent, ".goalchainer-stage-"));
    const stagedPath = join(stagingRoot, "goalchainer");
    await writeSnapshot(stagedPath, source);
    const stagedSnapshot = await snapshotTree(stagedPath, "Staged skill");
    if (!treesEqual(source, stagedSnapshot)) {
      throw new Error(`Staged skill does not match its canonical source: ${plan.path}`);
    }

    const current = await inspectDestination(plan.path);
    if (!destinationSnapshotsEqual(plan.expected, current)) {
      throw new Error(`Skill destination changed during installation: ${plan.path}`);
    }

    if (plan.action === "install") {
      await rename(stagedPath, plan.path);
      return { plan, cleanupRoots: [stagingRoot], createdParents };
    }

    const backup = await replaceKeepingBackup(stagedPath, plan.path, plan.expected);
    return {
      plan,
      ...backup,
      cleanupRoots: [stagingRoot, backup.backupRoot],
      createdParents,
    };
  } catch (installError) {
    const cleanupErrors: unknown[] = [];
    if (stagingRoot !== undefined) {
      try {
        await removePrivateTree(stagingRoot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    cleanupErrors.push(...(await removeCreatedParents(createdParents)));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [installError, ...cleanupErrors],
        "Agent Skill installation failed and its private filesystem changes could not be removed",
      );
    }
    throw installError;
  }
}

async function restoreCompleted(completed: CompletedPlan, source: TreeSnapshot): Promise<void> {
  const { plan, backupPath, backupRoot } = completed;
  const current = await inspectDestination(plan.path);
  if (current.kind !== "directory" || !treesEqual(current.tree, source)) {
    const backupMessage = backupPath ? ` The previous destination remains at ${backupPath}.` : "";
    throw new Error(
      `Installed skill changed before transaction rollback: ${plan.path}.${backupMessage}`,
    );
  }

  if (!backupPath || !backupRoot) {
    await removePrivateTree(plan.path);
    await removePrivateTree(completed.cleanupRoots[0]!);
    const parentErrors = await removeCreatedParents(completed.createdParents);
    if (parentErrors.length > 0) {
      throw new AggregateError(parentErrors, "Installed skill was removed, but empty parents remain");
    }
    return;
  }

  const installedPath = join(backupRoot, "installed");
  await rename(plan.path, installedPath);
  try {
    await rename(backupPath, plan.path);
  } catch (restoreError) {
    try {
      await rename(installedPath, plan.path);
    } catch (recoveryError) {
      throw new AggregateError(
        [restoreError, recoveryError],
        `Failed to restore ${plan.path}. The previous destination remains at ${backupPath}, and the installed tree remains at ${installedPath}`,
      );
    }
    throw new Error(
      `Failed to restore ${plan.path}. The previous destination remains at ${backupPath}`,
      { cause: restoreError },
    );
  }

  await removePrivateTree(installedPath);
  for (const root of completed.cleanupRoots) {
    await removePrivateTree(root);
  }
  const parentErrors = await removeCreatedParents(completed.createdParents);
  if (parentErrors.length > 0) {
    throw new AggregateError(parentErrors, "Previous skill was restored, but empty parents remain");
  }
}

interface ValidatedInstallRequest {
  agent: AgentTarget;
  scope: SkillInstallScope;
  base: string;
  force: boolean;
}

function validateOptions(options: SkillInstallOptions): ValidatedInstallRequest {
  assertPlainRecord(options, "Skill installation options");
  assertKnownKeys(options, "Skill installation options", [
    "agent",
    "scope",
    "projectRoot",
    "homeDir",
    "force",
  ]);
  if (![...CONCRETE_TARGETS, "all"].includes(options.agent)) {
    throw new TypeError(`Unsupported agent target: ${String(options.agent)}`);
  }
  if (options.scope !== "project" && options.scope !== "user") {
    throw new TypeError(`Unsupported skill installation scope: ${String(options.scope)}`);
  }
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new TypeError("Skill installation force must be a boolean");
  }
  for (const [field, value] of [
    ["projectRoot", options.projectRoot],
    ["homeDir", options.homeDir],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new TypeError(`Skill installation ${field} must be a nonblank string`);
    }
  }
  const base = options.scope === "project"
    ? resolve(options.projectRoot === undefined ? process.cwd() : options.projectRoot)
    : resolve(options.homeDir === undefined ? homedir() : options.homeDir);
  return Object.freeze({
    agent: options.agent,
    scope: options.scope,
    base,
    force: options.force === true,
  });
}

function targetsFor(agent: AgentTarget): readonly ConcreteAgentTarget[] {
  return agent === "all" ? ["codex", "claude"] : [agent];
}

async function planTarget(
  path: string,
  base: string,
  source: TreeSnapshot,
  force: boolean,
): Promise<TargetPlan> {
  await inspectSafeParentPath(base, dirname(path), false);
  const expected = await inspectDestination(path);
  if (expected.kind === "directory" && treesEqual(expected.tree, source)) {
    return { path, base, expected, action: "unchanged" };
  }
  if (expected.kind !== "missing" && !force) {
    throw new Error(
      `Skill destination already exists with different contents or modes: ${path}. Use force to replace it.`,
    );
  }
  return {
    path,
    base,
    expected,
    action: expected.kind === "missing" ? "install" : "replace",
  };
}

/** Installs the packaged GoalChainer Agent Skill into one or more agent layouts. */
export async function installAgentSkill(
  options: SkillInstallOptions,
): Promise<SkillInstallResult> {
  const request = validateOptions(options);
  const source = await snapshotTree(CANONICAL_SKILL_ROOT, "Canonical skill source");
  if (!source.files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Canonical skill source has no SKILL.md: ${CANONICAL_SKILL_ROOT}`);
  }

  const base = request.base;
  const plans: TargetPlan[] = [];
  for (const agent of targetsFor(request.agent)) {
    const path = resolve(base, ...TARGET_SEGMENTS[request.scope][agent]);
    assertContained(base, path);
    plans.push(await planTarget(path, base, source, request.force));
  }

  const installed: string[] = [];
  const unchanged: string[] = [];
  const completed: CompletedPlan[] = [];
  try {
    for (const plan of plans) {
      if (plan.action === "unchanged") {
        unchanged.push(plan.path);
        continue;
      }
      completed.push(await materializePlan(plan, source));
      installed.push(plan.path);
    }
  } catch (installError) {
    const rollbackErrors: unknown[] = [];
    for (const completedPlan of completed.reverse()) {
      try {
        await restoreCompleted(completedPlan, source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [installError, ...rollbackErrors],
        "Agent Skill installation failed and one or more prior targets could not be fully rolled back",
      );
    }
    throw installError;
  }

  const cleanupErrors: unknown[] = [];
  const retainedRoots: string[] = [];
  for (const completedPlan of completed) {
    for (const root of completedPlan.cleanupRoots) {
      try {
        await removePrivateTree(root);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        retainedRoots.push(root);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Agent Skill installation committed, but private installation directories could not be removed: ${retainedRoots.join(", ")}`,
    );
  }

  return Object.freeze({
    installed: Object.freeze(installed),
    unchanged: Object.freeze(unchanged),
  });
}
