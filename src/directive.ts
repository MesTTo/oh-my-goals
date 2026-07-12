// Generic task planning and claim lifecycle through goalchainer.metta.

import { NORM_STATUSES, type NormStatus } from "./deontic.js";
import {
  createGoalChainerMetta,
  mettaCall,
  mettaInteger,
  mettaString,
  mettaSymbol,
  sharedGoalChainerMetta,
  type GoalChainerMetta,
  type Term,
} from "./metta.js";
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
  const groups = sharedGoalChainerMetta().evalJsMany(taskIds.map((taskId) =>
    mettaCall("gc-directive-task-state", mettaSymbol(normStatusForTask(normStatusByTask, taskId))),
  ));
  const output = groups.map((values, index) => {
    const taskId = taskIds[index]!;
    if (values.length !== 1 || !isTaskState(values[0])) {
      throw new Error(
        `goalchainer.metta returned invalid task state for ${taskId}: ${JSON.stringify(values)}`,
      );
    }
    return values[0];
  });
  const states = Object.freeze(
    Object.fromEntries(taskIds.map((taskId, index) => [taskId, output[index]!])) as Record<
      string,
      DirectiveTaskState
    >,
  );
  return { states, output: Object.freeze(output) };
}

function orderedTasks(rows: readonly unknown[], context: string): string[] {
  const parsed = rows.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      row[0] !== "DirectiveStatusRow" ||
      typeof row[1] !== "number" ||
      typeof row[2] !== "string"
    ) {
      throw new Error(`goalchainer.metta returned invalid ${context} row: ${JSON.stringify(row)}`);
    }
    return { order: row[1], task: row[2] };
  });
  return parsed.sort((left, right) => left.order - right.order).map((row) => row.task);
}

function readDuplicateClaim(value: unknown, task: string): DirectiveClaim | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== "ExistingClaim" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "number" ||
    !Number.isSafeInteger(value[2])
  ) {
    throw new Error(`goalchainer.metta returned invalid duplicate-claim guard for ${task}`);
  }
  return { ok: true, task, agent: value[1], version: value[2] };
}

function readClaimReceipt(value: unknown, task: string): DirectiveClaim {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "ClaimReceipt" ||
    value[1] !== task ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "number" ||
    !Number.isSafeInteger(value[3])
  ) {
    throw new Error(`goalchainer.metta returned invalid claim receipt for ${task}`);
  }
  return { ok: true, task, agent: value[2], version: value[3] };
}

function taskFact(
  task: string,
  order: number,
  state: DirectiveTaskState,
  agent: string,
): Term {
  return mettaCall(
    "DirectiveTask",
    mettaString(task),
    mettaInteger(order),
    mettaSymbol(state),
    mettaString(agent),
    mettaString(`assign:${task}`),
  );
}

/** A fact-backed task lifecycle. MeTTa derives every observable state transition guard. */
export class DirectiveLifecycle {
  private readonly db: GoalChainerMetta = createGoalChainerMetta();
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
    config.taskIds.forEach((taskId, order) => {
      const state = ownValue(config.taskStates, taskId);
      if (!isTaskState(state)) {
        throw new TypeError(`unsupported task state for ${taskId}: ${String(state)}`);
      }
      this.db.add(
        taskFact(taskId, order, state, config.agent),
        mettaCall("DirectiveClaimOpen", mettaString(taskId)),
      );
    });
  }

  status(): DirectiveStatus {
    return {
      ready: orderedTasks(
        this.db.evalJs(mettaCall("gc-directive-status-rows", mettaSymbol("ready"))),
        "ready status",
      ),
      blocked: orderedTasks(
        this.db.evalJs(mettaCall("gc-directive-status-rows", mettaSymbol("blocked"))),
        "blocked status",
      ),
      claimed: orderedTasks(
        this.db.evalJs(mettaCall("gc-directive-status-rows", mettaSymbol("claimed"))),
        "claimed status",
      ),
    };
  }

  next(): DirectiveAssignment[] {
    const rows = this.db.evalJs(mettaCall("gc-directive-next-rows")).map((row) => {
      if (
        !Array.isArray(row) ||
        row.length !== 5 ||
        row[0] !== "DirectiveNextRow" ||
        typeof row[1] !== "number" ||
        typeof row[2] !== "string" ||
        typeof row[3] !== "string" ||
        typeof row[4] !== "string"
      ) {
        throw new Error(`goalchainer.metta returned invalid next-assignment row: ${JSON.stringify(row)}`);
      }
      return { order: row[1], task: row[2], agent: row[3], rule: row[4] };
    });
    return rows
      .sort((left, right) => left.order - right.order)
      .map(({ task, agent, rule }) => ({ task, agent, rule }));
  }

  claim(task: string): DirectiveClaimResult {
    validateIdentifier(task, "task id");
    const taskId = mettaString(task);
    if (this.db.evalJs(mettaCall("gc-directive-known-task", taskId))[0] !== true) {
      return { ok: false, code: "task_not_found", task, available: [...this.taskIds] };
    }
    const duplicate = readDuplicateClaim(
      this.db.evalJs(mettaCall("gc-directive-duplicate-claim", taskId))[0],
      task,
    );
    if (duplicate !== undefined) {
      return { ok: false, code: "already_claimed", task, claim: duplicate };
    }
    const state = this.db.evalJs(mettaCall("gc-directive-readiness", taskId))[0];
    if (!isTaskState(state)) {
      throw new Error(`goalchainer.metta returned invalid readiness for ${task}: ${String(state)}`);
    }
    if (state !== "ready") return { ok: false, code: "not_ready", task, state };
    if (this.db.evalJs(mettaCall("gc-directive-claimable", taskId))[0] !== true) {
      throw new Error(`goalchainer.metta rejected an unclaimed ready task: ${task}`);
    }

    const openFact = mettaCall("DirectiveClaimOpen", taskId);
    const claimFact = mettaCall(
      "DirectiveClaim",
      taskId,
      mettaString(this.agent),
      mettaInteger(1),
    );
    if (!this.db.remove(openFact)) {
      const raced = readDuplicateClaim(
        this.db.evalJs(mettaCall("gc-directive-duplicate-claim", taskId))[0],
        task,
      );
      if (raced !== undefined) {
        return { ok: false, code: "already_claimed", task, claim: raced };
      }
      throw new Error(`claim slot disappeared for ${task}`);
    }
    try {
      this.db.add(claimFact);
      return readClaimReceipt(
        this.db.evalJs(mettaCall("gc-directive-claim-receipt", taskId))[0],
        task,
      );
    } catch (error) {
      this.db.remove(claimFact);
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

/** Compare the native task-state relation with the packaged SWI-Prolog predicate. */
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
  const [
    { fileURLToPath },
    { mettaDB },
    { importPrologFunctionsFromFile },
    { registerPrologInterop },
    { swiPrologBridge },
  ] = await Promise.all([
    import("node:url"),
    import("@metta-ts/edsl"),
    import("@metta-ts/edsl/prolog"),
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
      const results = await db.evalJsAsync(
        mettaCall("gc_task_state", mettaSymbol(normStatus)),
      );
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
