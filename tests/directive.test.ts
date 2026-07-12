import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DirectiveLifecycle,
  checkDirectivePrologParity,
  classifyTaskStates,
  createDirectivePlan,
  type DirectiveTaskState,
  type NormStatusByTask,
} from "../src/directive.js";
import { NORM_STATUSES, type NormStatus } from "../src/deontic.js";

const TASK_IDS = ["raw-report", "reviewed-summary", "wait-for-facts"] as const;
const NORM_STATUS: NormStatusByTask = {
  "raw-report": "forbidden",
  "reviewed-summary": "obligated",
  "wait-for-facts": "permitted",
};

function lifecycle(
  taskIds: readonly string[] = TASK_IDS,
  normStatusByTask: NormStatusByTask = NORM_STATUS,
): DirectiveLifecycle {
  const { states } = classifyTaskStates(taskIds, normStatusByTask);
  return new DirectiveLifecycle({ taskIds, taskStates: states, agent: "worker-7" });
}

describe("generic task-state classification", () => {
  it("maps every norm status through one @metta-ts rule", () => {
    const taskIds = [...NORM_STATUSES];
    const statuses = Object.fromEntries(
      NORM_STATUSES.map((status) => [status, status]),
    ) as Record<string, NormStatus>;

    expect(classifyTaskStates(taskIds, statuses)).toEqual({
      states: {
        unregulated: "backlog",
        permitted: "backlog",
        obligated: "ready",
        forbidden: "blocked",
        conflict: "blocked",
      },
      output: ["backlog", "backlog", "ready", "blocked", "blocked"],
    });
  });

  it("preserves arbitrary caller order and treats an omitted status as unregulated", () => {
    const taskIds = ["unicode-λ", "__proto__", "task with spaces", "last"];
    const statuses = Object.fromEntries([
      ["task with spaces", "obligated"],
      ["__proto__", "conflict"],
      ["unicode-λ", "permitted"],
    ]) as Record<string, NormStatus>;
    const result = classifyTaskStates(taskIds, statuses);

    expect(result.output).toEqual(["backlog", "blocked", "ready", "backlog"]);
    expect(Object.entries(result.states)).toEqual([
      ["unicode-λ", "backlog"],
      ["__proto__", "blocked"],
      ["task with spaces", "ready"],
      ["last", "backlog"],
    ]);
  });

  it("treats an explicitly undefined norm status as the documented default", () => {
    expect(classifyTaskStates(["task"], { task: undefined })).toEqual({
      states: { task: "backlog" },
      output: ["backlog"],
    });
  });

  it("rejects duplicate, empty, and invalid runtime input", () => {
    expect(() => classifyTaskStates(["a", "a"], {})).toThrow("duplicate task id: a");
    expect(() => classifyTaskStates([""], {})).toThrow("task id at index 0 must not be empty");
    expect(() =>
      classifyTaskStates(["a"], { a: "allowed" as NormStatus }),
    ).toThrow("unsupported norm status for a: allowed");
    expect(() => classifyTaskStates(["a"], 42 as any)).toThrow(
      "norm statuses by task must be a plain object record",
    );
    expect(() => classifyTaskStates(["a"], { typo: "obligated" })).toThrow(
      "norm statuses reference unknown task IDs: typo",
    );
  });

  it("classifies a generated ordered task set without fixed IDs", () => {
    const expectedState: Record<NormStatus, DirectiveTaskState> = {
      unregulated: "backlog",
      permitted: "backlog",
      obligated: "ready",
      forbidden: "blocked",
      conflict: "blocked",
    };
    const taskIds = Array.from({ length: 125 }, (_, index) => `generated/${124 - index}`);
    const statuses = Object.fromEntries(
      taskIds.map((taskId, index) => [taskId, NORM_STATUSES[index % NORM_STATUSES.length]!]),
    ) as Record<string, NormStatus>;
    const result = classifyTaskStates(taskIds, statuses);

    expect(result.output).toEqual(
      taskIds.map((taskId) => expectedState[statuses[taskId]!]),
    );
    expect(Object.keys(result.states)).toEqual(taskIds);
  });
});

describe("fact-backed directive lifecycle", () => {
  it("supports an empty caller-supplied task set", () => {
    const instance = lifecycle([], {});

    expect(instance.status()).toEqual({ ready: [], blocked: [], claimed: [] });
    expect(instance.next()).toEqual([]);
  });

  it("derives status and next assignments in caller order", () => {
    const instance = lifecycle();

    expect(instance.status()).toEqual({
      ready: ["reviewed-summary"],
      blocked: ["raw-report"],
      claimed: [],
    });
    expect(instance.next()).toEqual([
      {
        agent: "worker-7",
        rule: "assign:reviewed-summary",
        task: "reviewed-summary",
      },
    ]);
  });

  it("returns typed failures for unknown and non-ready tasks", () => {
    const instance = lifecycle();

    expect(instance.claim("missing")).toEqual({
      ok: false,
      code: "task_not_found",
      task: "missing",
      available: [...TASK_IDS],
    });
    expect(instance.claim("raw-report")).toEqual({
      ok: false,
      code: "not_ready",
      task: "raw-report",
      state: "blocked",
    });
    expect(instance.claim("wait-for-facts")).toEqual({
      ok: false,
      code: "not_ready",
      task: "wait-for-facts",
      state: "backlog",
    });
  });

  it("stores a claim fact, removes it from next, and derives duplicate receipts", () => {
    const instance = lifecycle();
    const receipt = {
      ok: true as const,
      agent: "worker-7",
      task: "reviewed-summary",
      version: 1,
    };

    expect(instance.claim("reviewed-summary")).toEqual(receipt);
    expect(instance.next()).toEqual([]);
    expect(instance.status()).toEqual({
      ready: ["reviewed-summary"],
      blocked: ["raw-report"],
      claimed: ["reviewed-summary"],
    });
    expect(instance.claim("reviewed-summary")).toEqual({
      ok: false,
      code: "already_claimed",
      task: "reviewed-summary",
      claim: receipt,
    });
  });

  it("handles generated ready tasks and preserves their configured order after claims", () => {
    const taskIds = Array.from({ length: 64 }, (_, index) => `task-${63 - index}`);
    const statuses = Object.fromEntries(
      taskIds.map((taskId, index) => [taskId, index % 3 === 0 ? "obligated" : "permitted"]),
    ) as Record<string, NormStatus>;
    const instance = lifecycle(taskIds, statuses);
    const ready = taskIds.filter((_, index) => index % 3 === 0);

    expect(instance.status().ready).toEqual(ready);
    expect(instance.next().map((assignment) => assignment.task)).toEqual(ready);
    for (const taskId of ready) expect(instance.claim(taskId).ok).toBe(true);
    expect(instance.next()).toEqual([]);
    expect(instance.status().claimed).toEqual(ready);
  });

  it("rejects a lifecycle state outside the public state set", () => {
    expect(
      () =>
        new DirectiveLifecycle({
          taskIds: ["task"],
          taskStates: { task: "waiting" as DirectiveTaskState },
          agent: "worker",
        }),
    ).toThrow("unsupported task state for task: waiting");
  });
});

describe("directive plan construction", () => {
  it("uses only caller-supplied plan identity, title, agent, and task IDs", () => {
    const mutableIds = ["quote\"task", "second"];
    const mutableStatuses: Record<string, NormStatus> = {
      "quote\"task": "obligated",
      second: "forbidden",
    };
    const plan = createDirectivePlan({
      id: "release/42",
      title: "Review \"release\"",
      agent: "agent with spaces",
      taskIds: mutableIds,
      normStatusByTask: mutableStatuses,
    });
    mutableIds.reverse();
    mutableStatuses["quote\"task"] = "forbidden";

    expect(plan.taskIds).toEqual(["quote\"task", "second"]);
    expect(plan.taskStates).toEqual({ "quote\"task": "ready", second: "blocked" });
    expect(plan.source).toBe(
      '(directive-plan "release/42" "Review \\"release\\"" "agent with spaces")\n' +
        '(directive-task "release/42" 0 "quote\\"task" ready)\n' +
        '(directive-task "release/42" 1 "second" blocked)\n',
    );
    expect(plan.lifecycle.next()[0]).toEqual({
      task: "quote\"task",
      agent: "agent with spaces",
      rule: 'assign:quote"task',
    });
  });

  it("rejects missing caller-owned identity fields", () => {
    const base = {
      id: "plan",
      title: "Plan",
      agent: "agent",
      taskIds: [] as string[],
      normStatusByTask: {},
    };

    expect(() => createDirectivePlan({ ...base, id: "" })).toThrow("plan id must not be empty");
    expect(() => createDirectivePlan({ ...base, title: "" })).toThrow(
      "plan title must not be empty",
    );
    expect(() => createDirectivePlan({ ...base, agent: "" })).toThrow("agent must not be empty");
    expect(() => createDirectivePlan({ ...base, id: 1 as any })).toThrow(
      "plan id must be a string",
    );
    expect(() => createDirectivePlan({ ...base, title: 2 as any })).toThrow(
      "plan title must be a string",
    );
    expect(() => createDirectivePlan({ ...base, agent: 3 as any })).toThrow(
      "agent must be a string",
    );
    expect(() => createDirectivePlan({ ...base, title: "   " })).toThrow(
      "plan title must not be empty",
    );
    expect(() => classifyTaskStates([1] as any, {})).toThrow(
      "task id at index 0 must be a string",
    );
    expect(
      () => new DirectiveLifecycle({ taskIds: [], taskStates: {}, agent: 3 as any }),
    ).toThrow("agent must be a string");
    expect(() =>
      new DirectiveLifecycle({
        taskIds: ["known"],
        taskStates: { known: "ready", ghost: "blocked" },
        agent: "worker",
      }),
    ).toThrow("directive task states reference unknown task IDs: ghost");
    expect(() => createDirectivePlan({ ...base, taskIds: "ab" as any })).toThrow(
      "task ids must be an array",
    );
  });
});

describe("packaged Prolog parity", () => {
  const source = readFileSync(new URL("../assets/gc_directive.pl", import.meta.url), "utf8");

  it("defines one outcome for every public norm status", () => {
    for (const normStatus of NORM_STATUSES) {
      expect(source).toMatch(new RegExp(`gc_task_state\\(${normStatus},\\s*\\w+\\)\\.`));
    }
  });

  it("rejects an invalid parity case before starting SWI", async () => {
    await expect(
      checkDirectivePrologParity({ normStatuses: ["allowed" as NormStatus] }),
    ).rejects.toThrow("unsupported norm status at index 0: allowed");
    await expect(checkDirectivePrologParity({ normStatuses: [] })).rejects.toThrow(
      "requires at least one norm status",
    );
    await expect(checkDirectivePrologParity({ executable: 7 as any })).rejects.toThrow(
      "executable must be a nonblank string",
    );
    await expect(checkDirectivePrologParity({ normStatuses: null as any })).rejects.toThrow(
      "norm statuses must be an array",
    );
    await expect(
      checkDirectivePrologParity({ normStatus: ["forbidden"] } as any),
    ).rejects.toThrow("directive Prolog parity options contains unknown fields: normStatus");
  });

  const hasSwi = spawnSync("swipl", ["--version"], { encoding: "utf8" }).status === 0;
  const liveIt = hasSwi ? it : it.skip;
  liveIt("matches the @metta-ts rule through a real SWI process", async () => {
    const parity = await checkDirectivePrologParity();

    expect(parity.matches).toBe(true);
    expect(parity.rows).toHaveLength(NORM_STATUSES.length);
    expect(parity.rows.every((row) => row.matches)).toBe(true);
  });
});
