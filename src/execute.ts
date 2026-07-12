// Execute a selected action through caller-owned handlers and check disclosures.

import { createDecision, type Decision } from "./models.js";
import { stableJson } from "./json.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord, ownValue } from "./records.js";

export type ActionExecutor<Context, Output> = (
  context: Context,
  decision: Decision,
) => Output | Promise<Output>;

export type ActionExecutors<Context, Output> = Readonly<
  Record<string, ActionExecutor<Context, Output>>
>;

export interface ExecutionReceipt<Output> {
  actionId: string;
  status: string;
  output: Output;
}

export class BlockedDecisionError extends Error {
  constructor(readonly decision: Decision) {
    super(`refusing to execute blocked action: ${decision.actionId}`);
    this.name = "BlockedDecisionError";
  }
}

export class MissingExecutorError extends Error {
  constructor(readonly actionId: string) {
    super(`no executor is registered for action: ${actionId}`);
    this.name = "MissingExecutorError";
  }
}

export class InvalidDecisionError extends Error {
  constructor(
    readonly decision: Decision,
    message: string,
  ) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

/** Execute one non-blocked decision through an explicitly registered handler. */
export async function executeDecision<Context, Output>(
  decision: Decision,
  context: Context,
  executors: ActionExecutors<Context, Output>,
): Promise<ExecutionReceipt<Output>> {
  let validated: Decision;
  try {
    validated = createDecision(decision);
  } catch (error) {
    throw new InvalidDecisionError(
      decision,
      `invalid decision: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (validated.status === "blocked") throw new BlockedDecisionError(validated);
  assertPlainRecord(executors, "action executors");
  const executor = ownValue(executors, validated.actionId);
  if (typeof executor !== "function") throw new MissingExecutorError(validated.actionId);
  return {
    actionId: validated.actionId,
    status: validated.status,
    output: await executor(context, validated),
  };
}

export interface RedactionPolicy {
  restrictedFields: readonly string[];
  /** When present, omit every unrestricted field not in this allowlist. */
  allowedFields?: readonly string[];
  replacement?: unknown;
}

/** Redact selected top-level fields and optionally apply an allowlist. */
export function redactRecord(
  input: Readonly<Record<string, unknown>>,
  policy: RedactionPolicy,
): Record<string, unknown> {
  assertPlainRecord(input, "redaction input");
  assertPlainRecord(policy, "redaction policy");
  assertKnownKeys(policy, "redaction policy", [
    "restrictedFields",
    "allowedFields",
    "replacement",
  ]);
  assertDenseArray(policy.restrictedFields, "restricted fields");
  policy.restrictedFields.forEach((field, index) => {
    if (typeof field !== "string") {
      throw new TypeError(`restricted fields[${index}] must be a string`);
    }
  });
  if (policy.allowedFields !== undefined) {
    assertDenseArray(policy.allowedFields, "allowed fields");
    policy.allowedFields.forEach((field, index) => {
      if (typeof field !== "string") {
        throw new TypeError(`allowed fields[${index}] must be a string`);
      }
    });
  }
  const restricted = new Set(policy.restrictedFields);
  const allowed = policy.allowedFields === undefined ? null : new Set(policy.allowedFields);
  const replacement = Object.hasOwn(policy, "replacement")
    ? policy.replacement
    : "[redacted]";
  const output: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (restricted.has(key)) output.push([key, replacement]);
    else if (allowed === null || allowed.has(key)) output.push([key, value]);
  }
  return Object.fromEntries(output);
}

function jsonText(value: unknown): string {
  try {
    return stableJson(value);
  } catch (error) {
    throw new TypeError(
      `artifact must be JSON-serializable for leak detection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Check whether any exact restricted value remains in a JSON artifact. */
export function detectLeaks(
  artifact: unknown,
  restrictedValues: readonly string[],
): { safe: boolean; leaked: string[] } {
  assertDenseArray(restrictedValues, "restricted values");
  restrictedValues.forEach((value, index) => {
    if (typeof value !== "string") {
      throw new TypeError(`restricted values[${index}] must be a string`);
    }
  });
  const serialized = jsonText(artifact);
  const normalized = JSON.parse(serialized);
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null) {
      strings.push("null");
      return;
    }
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      strings.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        strings.push(key);
        visit(child);
      }
    }
  };
  visit(normalized);
  const leaked = [
    ...new Set(
      restrictedValues.filter(
        (restricted) =>
          restricted !== "" && strings.some((value) => value.includes(restricted)),
      ),
    ),
  ];
  return { safe: leaked.length === 0, leaked };
}
