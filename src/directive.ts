// Generic task planning and claim lifecycle on the @metta-ts interpreter.

import {
  If,
  Match,
  e,
  eq,
  ground,
  names,
  or,
  vars,
} from "@metta-ts/edsl";
import { importPrologFunctionsFromFile } from "@metta-ts/edsl/prolog";

import { NORM_STATUSES, type NormStatus } from "./deontic.js";
import { mettaDB, type MettaDB } from "./engine.js";
import { resolvePrologExecutable } from "./prolog_runtime.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord, ownValue } from "./records.js";

export const DIRECTIVE_TASK_STATES = Object.freeze(["ready", "blocked", "backlog"] as const);

export type DirectiveTaskState = (typeof DIRECTIVE_TASK_STATES)[number];
export type NormStatusByTask = Readonly<Record<string, NormStatus | undefined>>;

export interface TaskStateClassification {
  readonly states: Readonly<Record<string, DirectiveTaskState>>;
  readonly output: readonly DirectiveTaskState[];
}

export interface DirectiveAssignment {
  readonly agent: string;
  readonly rule: string;
  readonly task: string;
}

export interface DirectiveStatus {
  readonly ready: readonly string[];
  readonly blocked: readonly string[];
  readonly claimed: readonly string[];
}

export interface DirectiveClaim {
  readonly ok: true;
  readonly agent: string;
  readonly task: string;
  readonly version: number;
}

export type DirectiveClaimError =
  | {
      readonly ok: false;
      readonly code: "task_not_found";
      readonly task: string;
      readonly available: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "not_ready";
      readonly task: string;
      readonly state: DirectiveTaskState;
    }
  | {
      readonly ok: false;
      readonly code: "already_claimed";
      readonly task: string;
      readonly claim: DirectiveClaim;
    };

export type DirectiveClaimResult = DirectiveClaim | DirectiveClaimError;

export interface DirectiveLifecycleConfig {
  readonly taskIds: readonly string[];
  readonly taskStates: Readonly<Record<string, DirectiveTaskState>>;
  readonly agent: string;
}

export interface DirectivePlanConfig {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly taskIds: readonly string[];
  readonly normStatusByTask: NormStatusByTask;
}

export interface DirectivePlan {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly taskIds: readonly string[];
  readonly taskStates: Readonly<Record<string, DirectiveTaskState>>;
  readonly source: string;
  readonly lifecycle: DirectiveLifecycle;
}

export interface DirectivePrologParityOptions {
  readonly executable?: string;
  readonly normStatuses?: readonly NormStatus[];
}

export interface DirectivePrologParityRow {
  readonly normStatus: NormStatus;
  readonly mettaState: DirectiveTaskState;
  readonly prologState: DirectiveTaskState;
  readonly matches: boolean;
}

export interface DirectivePrologParity {
  readonly asset: "assets/gc_directive.pl";
  readonly rows: readonly DirectivePrologParityRow[];
  readonly matches: boolean;
}

const TASK_STATE_SET: ReadonlySet<string> = new Set(DIRECTIVE_TASK_STATES);
const NORM_STATUS_SET: ReadonlySet<string> = new Set(NORM_STATUSES);
const PROLOG_ASSET = new URL("../assets/gc_directive.pl", import.meta.url);

type DirectiveName =
  | NormStatus
  | DirectiveTaskState
  | "invalid"
  | "claimed"
  | "directive-task-state-for-norm"
  | "directive-task-order"
  | "directive-task-state"
  | "directive-task-assignment"
  | "directive-claim-open"
  | "directive-task-claim"
  | "directive-status-rows"
  | "directive-next-rows"
  | "directive-readiness"
  | "directive-known-task"
  | "directive-duplicate-claim"
  | "directive-claimable"
  | "directive-claim-receipt"
  | "gc_task_state";

const n = names<DirectiveName>();
const taskStateForNorm = n["directive-task-state-for-norm"];
const taskOrder = n["directive-task-order"];
const taskState = n["directive-task-state"];
const taskAssignment = n["directive-task-assignment"];
const claimOpen = n["directive-claim-open"];
const taskClaim = n["directive-task-claim"];
const statusRows = n["directive-status-rows"];
const nextRows = n["directive-next-rows"];
const readiness = n["directive-readiness"];
const knownTask = n["directive-known-task"];
const duplicateClaim = n["directive-duplicate-claim"];
const claimable = n["directive-claimable"];
const claimReceipt = n["directive-claim-receipt"];
const prologTaskState = n.gc_task_state;

function isNormStatus(value: unknown): value is NormStatus {
  return typeof value === "string" && NORM_STATUS_SET.has(value);
}

function isTaskState(value: unknown): value is DirectiveTaskState {
  return typeof value === "string" && TASK_STATE_SET.has(value);
}

function validateIdentifier(value: string, field: string): void {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (value.trim() === "") throw new TypeError(`${field} must not be empty`);
}

function validateTaskIds(taskIds: readonly string[]): void {
  assertDenseArray(taskIds, "task ids");
  const seen = new Set<string>();
  taskIds.forEach((taskId, index) => {
    validateIdentifier(taskId, `task id at index ${index}`);
    if (seen.has(taskId)) throw new TypeError(`duplicate task id: ${taskId}`);
    seen.add(taskId);
  });
}

function normStatusForTask(statuses: NormStatusByTask, taskId: string): NormStatus {
  const declared = ownValue(statuses, taskId);
  const value = declared === undefined ? "unregulated" : declared;
  if (!isNormStatus(value)) {
    throw new TypeError(`unsupported norm status for ${taskId}: ${String(value)}`);
  }
  return value;
}

function installTaskStateRule(db: MettaDB): void {
  const { status } = vars<{ status: string }>();
  db.rule(
    taskStateForNorm(status),
    If(
      eq(status, n.obligated),
      n.ready,
      If(
        or(eq(status, n.forbidden), eq(status, n.conflict)),
        n.blocked,
        If(
          or(eq(status, n.permitted), eq(status, n.unregulated)),
          n.backlog,
          n.invalid,
        ),
      ),
    ),
  );
}

/** Map ordered caller-supplied task IDs from norm status to directive state. */
export function classifyTaskStates(
  taskIds: readonly string[],
  normStatusByTask: NormStatusByTask,
): TaskStateClassification {
  validateTaskIds(taskIds);
  assertPlainRecord(normStatusByTask, "norm statuses by task");
  const taskIdSet = new Set(taskIds);
  const unknownTaskIds = Object.keys(normStatusByTask).filter((taskId) => !taskIdSet.has(taskId));
  if (unknownTaskIds.length > 0) {
    throw new RangeError(`norm statuses reference unknown task IDs: ${unknownTaskIds.join(", ")}`);
  }
  const db = mettaDB();
  installTaskStateRule(db);

  const output = taskIds.map((taskId) => {
    const normStatus = normStatusForTask(normStatusByTask, taskId);
    const result = db.evalJs(taskStateForNorm(n[normStatus]))[0];
    if (!isTaskState(result)) {
      throw new Error(`@metta-ts returned invalid task state for ${taskId}: ${String(result)}`);
    }
    return result;
  });
  const states = Object.freeze(
    Object.fromEntries(taskIds.map((taskId, index) => [taskId, output[index]!])) as Record<
      string,
      DirectiveTaskState
    >,
  );
  return { states, output: Object.freeze(output) };
}

function installLifecycleRules(db: MettaDB): void {
  const { task, order, state, agent, rule, version } = vars<{
    task: string;
    order: number;
    state: DirectiveTaskState;
    agent: string;
    rule: string;
    version: number;
  }>();

  db.rule(
    statusRows(n.ready),
    Match(taskState(task, n.ready), Match(taskOrder(task, order), e(order, task))),
  );
  db.rule(
    statusRows(n.blocked),
    Match(taskState(task, n.blocked), Match(taskOrder(task, order), e(order, task))),
  );
  db.rule(
    statusRows(n.claimed),
    Match(taskClaim(task, agent, version), Match(taskOrder(task, order), e(order, task))),
  );
  db.rule(readiness(task), Match(taskState(task, state), state));
  db.rule(knownTask(task), Match(taskOrder(task, order), true));
  db.rule(
    duplicateClaim(task),
    Match(taskClaim(task, agent, version), e(agent, version)),
  );
  db.rule(
    claimable(task),
    Match(taskState(task, n.ready), Match(claimOpen(task), true)),
  );
  db.rule(
    claimReceipt(task),
    Match(taskClaim(task, agent, version), e(task, agent, version)),
  );
  db.rule(
    nextRows(),
    Match(
      taskState(task, n.ready),
      Match(
        claimOpen(task),
        Match(
          taskOrder(task, order),
          Match(taskAssignment(task, agent, rule), e(order, task, agent, rule)),
        ),
      ),
    ),
  );
}

function orderedTasks(rows: readonly unknown[], context: string): string[] {
  const parsed = rows.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "number" ||
      typeof row[1] !== "string"
    ) {
      throw new Error(`@metta-ts returned invalid ${context} row: ${JSON.stringify(row)}`);
    }
    return { order: row[0], task: row[1] };
  });
  return parsed.sort((left, right) => left.order - right.order).map((row) => row.task);
}

function readDuplicateClaim(value: unknown, task: string): DirectiveClaim | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "number"
  ) {
    throw new Error(`@metta-ts returned invalid duplicate-claim guard for ${task}`);
  }
  return { ok: true, task, agent: value[0], version: value[1] };
}

function readClaimReceipt(value: unknown, task: string): DirectiveClaim {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== task ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "number"
  ) {
    throw new Error(`@metta-ts returned invalid claim receipt for ${task}`);
  }
  return { ok: true, task, agent: value[1], version: value[2] };
}

/** A fact-backed task lifecycle. Every observable result is read through MeTTa rules. */
export class DirectiveLifecycle {
  private readonly db = mettaDB();
  private readonly taskIds: readonly string[];
  private readonly agent: string;

  constructor(config: DirectiveLifecycleConfig) {
    assertPlainRecord(config, "directive lifecycle config");
    assertKnownKeys(config, "directive lifecycle config", ["taskIds", "taskStates", "agent"]);
    validateTaskIds(config.taskIds);
    validateIdentifier(config.agent, "agent");
    assertPlainRecord(config.taskStates, "directive task states");
    this.taskIds = Object.freeze([...config.taskIds]);
    const taskIdSet = new Set(this.taskIds);
    const unknownStateIds = Object.keys(config.taskStates).filter(
      (taskId) => !taskIdSet.has(taskId),
    );
    if (unknownStateIds.length > 0) {
      throw new RangeError(
        `directive task states reference unknown task IDs: ${unknownStateIds.join(", ")}`,
      );
    }
    this.agent = config.agent;
    installLifecycleRules(this.db);

    config.taskIds.forEach((taskId, order) => {
      const state = ownValue(config.taskStates, taskId);
      if (!isTaskState(state)) {
        throw new TypeError(`unsupported task state for ${taskId}: ${String(state)}`);
      }
      this.db.add(
        taskOrder(taskId, order),
        taskState(taskId, n[state]),
        taskAssignment(taskId, config.agent, `assign:${taskId}`),
        claimOpen(taskId),
      );
    });
  }

  status(): DirectiveStatus {
    return {
      ready: orderedTasks(this.db.evalJs(statusRows(n.ready)), "ready status"),
      blocked: orderedTasks(this.db.evalJs(statusRows(n.blocked)), "blocked status"),
      claimed: orderedTasks(this.db.evalJs(statusRows(n.claimed)), "claimed status"),
    };
  }

  next(): DirectiveAssignment[] {
    const rows = this.db.evalJs(nextRows()).map((row) => {
      if (
        !Array.isArray(row) ||
        row.length !== 4 ||
        typeof row[0] !== "number" ||
        typeof row[1] !== "string" ||
        typeof row[2] !== "string" ||
        typeof row[3] !== "string"
      ) {
        throw new Error(`@metta-ts returned invalid next-assignment row: ${JSON.stringify(row)}`);
      }
      return { order: row[0], task: row[1], agent: row[2], rule: row[3] };
    });
    return rows
      .sort((left, right) => left.order - right.order)
      .map(({ task, agent, rule }) => ({ task, agent, rule }));
  }

  claim(task: string): DirectiveClaimResult {
    validateIdentifier(task, "task id");
    if (this.db.evalJs(knownTask(task))[0] !== true) {
      return { ok: false, code: "task_not_found", task, available: [...this.taskIds] };
    }

    const duplicate = readDuplicateClaim(this.db.evalJs(duplicateClaim(task))[0], task);
    if (duplicate !== undefined) {
      return { ok: false, code: "already_claimed", task, claim: duplicate };
    }

    const state = this.db.evalJs(readiness(task))[0];
    if (!isTaskState(state)) {
      throw new Error(`@metta-ts returned invalid readiness for ${task}: ${String(state)}`);
    }
    if (state !== "ready") return { ok: false, code: "not_ready", task, state };
    if (this.db.evalJs(claimable(task))[0] !== true) {
      throw new Error(`@metta-ts rejected an unclaimed ready task: ${task}`);
    }

    const openFact = claimOpen(task);
    const claimFact = taskClaim(task, this.agent, 1);
    if (!this.db.metta.space().removeAtom(ground(openFact))) {
      const raced = readDuplicateClaim(this.db.evalJs(duplicateClaim(task))[0], task);
      if (raced !== undefined) {
        return { ok: false, code: "already_claimed", task, claim: raced };
      }
      throw new Error(`claim slot disappeared for ${task}`);
    }

    try {
      this.db.add(claimFact);
      return readClaimReceipt(this.db.evalJs(claimReceipt(task))[0], task);
    } catch (error) {
      this.db.metta.space().removeAtom(ground(claimFact));
      this.db.add(openFact);
      throw error;
    }
  }
}

function renderDirectivePlanSource(
  config: Pick<DirectivePlanConfig, "id" | "title" | "agent" | "taskIds">,
  states: Readonly<Record<string, DirectiveTaskState>>,
): string {
  const quoted = (value: string): string => JSON.stringify(value);
  const lines = [
    `(directive-plan ${quoted(config.id)} ${quoted(config.title)} ${quoted(config.agent)})`,
  ];
  config.taskIds.forEach((taskId, order) => {
    lines.push(
      `(directive-task ${quoted(config.id)} ${order} ${quoted(taskId)} ${ownValue(states, taskId)})`,
    );
  });
  return `${lines.join("\n")}\n`;
}

/** Create a plan from caller-owned identity, agent, task order, and norm results. */
export function createDirectivePlan(config: DirectivePlanConfig): DirectivePlan {
  assertPlainRecord(config, "directive plan config");
  assertKnownKeys(config, "directive plan config", [
    "id",
    "title",
    "agent",
    "taskIds",
    "normStatusByTask",
  ]);
  validateIdentifier(config.id, "plan id");
  validateIdentifier(config.title, "plan title");
  validateIdentifier(config.agent, "agent");
  validateTaskIds(config.taskIds);
  const taskIds = Object.freeze([...config.taskIds]);
  const { states } = classifyTaskStates(taskIds, config.normStatusByTask);
  const lifecycle = new DirectiveLifecycle({ taskIds, taskStates: states, agent: config.agent });
  return Object.freeze({
    id: config.id,
    title: config.title,
    agent: config.agent,
    taskIds,
    taskStates: states,
    source: renderDirectivePlanSource({ ...config, taskIds }, states),
    lifecycle,
  });
}

function ensureImported(importResults: readonly { toString(): string }[]): void {
  if (!importResults.some((result) => result.toString() === "True")) {
    throw new Error(
      `failed to import assets/gc_directive.pl: ${importResults.map(String).join(", ")}`,
    );
  }
}

/** Compare the MeTTa task-state rule with the packaged file through live SWI-Prolog. */
export async function checkDirectivePrologParity(
  options: DirectivePrologParityOptions = {},
): Promise<DirectivePrologParity> {
  assertPlainRecord(options, "directive Prolog parity options");
  assertKnownKeys(options, "directive Prolog parity options", ["executable", "normStatuses"]);
  const requestedStatuses = options.normStatuses === undefined ? NORM_STATUSES : options.normStatuses;
  assertDenseArray(requestedStatuses, "directive parity norm statuses");
  if (requestedStatuses.length === 0) {
    throw new RangeError("directive parity verification requires at least one norm status");
  }
  const normStatuses = Object.freeze([...requestedStatuses]);
  normStatuses.forEach((status, index) => {
    if (!isNormStatus(status)) {
      throw new TypeError(`unsupported norm status at index ${index}: ${String(status)}`);
    }
  });
  const executable = options.executable;
  if (executable !== undefined && (typeof executable !== "string" || executable.trim() === "")) {
    throw new TypeError("directive Prolog executable must be a nonblank string");
  }
  const resolvedExecutable = resolvePrologExecutable(executable);

  const [{ fileURLToPath }, { registerPrologInterop }, { swiPrologBridge }] = await Promise.all([
    import("node:url"),
    import("@metta-ts/prolog"),
    import("@metta-ts/prolog/swi-node"),
  ]);
  const bridge = swiPrologBridge({ executable: resolvedExecutable });

  try {
    const db = mettaDB();
    registerPrologInterop(db.metta, bridge);
    ensureImported(
      await db.evalAsync(
        importPrologFunctionsFromFile(fileURLToPath(PROLOG_ASSET), ["gc_task_state"]),
      ),
    );

    const taskIds = normStatuses.map((_, index) => `parity-${index}`);
    const statusByTask = Object.fromEntries(
      taskIds.map((taskId, index) => [taskId, normStatuses[index]!]),
    ) as Record<string, NormStatus>;
    const mettaStates = classifyTaskStates(taskIds, statusByTask).output;
    const rows: DirectivePrologParityRow[] = [];
    for (const [index, normStatus] of normStatuses.entries()) {
      const results = await db.evalJsAsync(prologTaskState(n[normStatus]));
      if (results.length !== 1 || !isTaskState(results[0])) {
        throw new Error(
          `SWI-Prolog returned invalid task state for ${normStatus}: ${JSON.stringify(results)}`,
        );
      }
      const mettaState = mettaStates[index]!;
      rows.push(Object.freeze({
        normStatus,
        mettaState,
        prologState: results[0],
        matches: mettaState === results[0],
      }));
    }
    return Object.freeze({
      asset: "assets/gc_directive.pl",
      rows: Object.freeze(rows),
      matches: rows.every((row) => row.matches),
    });
  } finally {
    await bridge.dispose();
  }
}
