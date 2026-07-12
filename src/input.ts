import { z } from "zod";

import {
  createCandidateAction,
  createGoal,
  createGoalScenario,
  createNorm,
  type EvidenceProjectionInput,
  type GoalScenario,
} from "./models.js";
import { assertDenseArray, assertNoInheritedKeys, assertPlainRecord } from "./records.js";
import { parseStv } from "./truth_value.js";

const identifierSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { error: "IDs must not be blank" });
const nonblankTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { error: "Text must not be blank" });
const sourceSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { error: "Evidence source must not be blank" });
const evidenceQuerySchema = z
  .string()
  .refine((value) => value === "" || value.trim().length > 0, {
    error: "Evidence query must be empty or nonblank",
  });
const probabilitySchema = z
  .number()
  .min(0, { error: "Probability must be between 0 and 1" })
  .max(1, { error: "Probability must be between 0 and 1" });

const goalSchema = z.strictObject({
  id: identifierSchema,
  owner: nonblankTextSchema,
  statement: nonblankTextSchema,
  weight: z.number().nonnegative({ error: "Goal weight must be non-negative" }),
  kind: z.enum(["individual", "collective"]),
  required: z.boolean().default(false),
});

const normSchema = z.strictObject({
  id: identifierSchema,
  mode: z.enum(["oblige", "permit", "forbid"]),
  targetAction: identifierSchema,
  reason: nonblankTextSchema,
  priority: z.int().default(0),
});

const candidateActionSchema = z
  .strictObject({
    id: identifierSchema,
    label: nonblankTextSchema,
    description: nonblankTextSchema,
    satisfies: z.array(identifierSchema),
    evidenceQuery: evidenceQuerySchema.default(""),
    evidenceAtoms: z.array(nonblankTextSchema).default(() => []),
    defaultStrength: probabilitySchema.default(0.5),
    defaultConfidence: probabilitySchema.default(0),
  })
  .superRefine((action, ctx) => {
    if (action.evidenceAtoms.length > 0 && action.evidenceQuery === "") {
      ctx.addIssue({
        code: "custom",
        message: "Evidence atoms require a nonempty evidence query",
        path: ["evidenceQuery"],
      });
    }
    const seen = new Set<string>();
    action.satisfies.forEach((goalId, index) => {
      if (seen.has(goalId)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate satisfies goal ID "${goalId}"`,
          path: ["satisfies", index],
        });
      }
      seen.add(goalId);
    });
  });

const evidenceProjectionSchema = z
  .strictObject({
    strength: probabilitySchema,
    confidence: probabilitySchema,
    source: sourceSchema,
    projection: z.string().nullable().default(null),
    proofs: z.array(z.string()).default(() => []),
    deontic: z
      .enum(["unregulated", "permitted", "obligated", "forbidden", "conflict"])
      .optional(),
    expectation: probabilitySchema.optional(),
  })
  .superRefine((evidence, ctx) => {
    let projected;
    try {
      projected = parseStv(evidence.projection);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
        path: ["projection"],
      });
      return;
    }
    if (projected === null) return;
    if (projected.some((value) => value < 0 || value > 1)) {
      ctx.addIssue({
        code: "custom",
        message: "Projection STV values must be between 0 and 1",
        path: ["projection"],
      });
      return;
    }
    if (
      Math.abs(projected[0] - evidence.strength) > 1e-12 ||
      Math.abs(projected[1] - evidence.confidence) > 1e-12
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Explicit truth value disagrees with projection STV",
        path: ["projection"],
      });
    }
  });

type ParsedEvidenceProjection = z.output<typeof evidenceProjectionSchema>;

const evidenceRecordSchema = z
  .unknown()
  .optional()
  .transform((value, ctx): Record<string, ParsedEvidenceProjection> => {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "evidence must be an object record" });
      return z.NEVER;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ctx.addIssue({ code: "custom", message: "evidence must be a plain object record" });
      return z.NEVER;
    }

    const entries: Array<readonly [string, ParsedEvidenceProjection]> = [];
    for (const [actionId, projection] of Object.entries(value)) {
      const keyResult = identifierSchema.safeParse(actionId);
      if (!keyResult.success) {
        for (const issue of keyResult.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: [actionId, ...issue.path],
          });
        }
        continue;
      }

      const projectionResult = evidenceProjectionSchema.safeParse(projection);
      if (!projectionResult.success) {
        for (const issue of projectionResult.error.issues) {
          ctx.addIssue({ ...issue, path: [actionId, ...issue.path] });
        }
        continue;
      }
      entries.push([actionId, projectionResult.data]);
    }
    return Object.fromEntries(entries);
  });

const scenarioSchema = z.strictObject({
  title: nonblankTextSchema,
  goals: z.array(goalSchema).min(1, { error: "scenario.goals must contain at least one goal" }),
  norms: z.array(normSchema),
  actions: z
    .array(candidateActionSchema)
    .min(1, { error: "scenario.actions must contain at least one action" }),
  notes: z.array(z.string()).default(() => []),
});

const rawGoalChainerInputSchema = z.strictObject({
  scenario: scenarioSchema,
  evidence: evidenceRecordSchema,
});

type RawGoalChainerInput = z.output<typeof rawGoalChainerInputSchema>;
type IssuePath = Array<string | number>;

function addDuplicateIdIssues(
  rows: readonly { id: string }[],
  entity: "goal" | "norm" | "action",
  path: IssuePath,
  ctx: z.RefinementCtx,
): void {
  const firstIndexById = new Map<string, number>();
  rows.forEach((row, index) => {
    if (firstIndexById.has(row.id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate ${entity} ID "${row.id}"`,
        path: [...path, index, "id"],
      });
      return;
    }
    firstIndexById.set(row.id, index);
  });
}

function checkReferences(input: RawGoalChainerInput, ctx: z.RefinementCtx): void {
  const { goals, norms, actions } = input.scenario;
  addDuplicateIdIssues(goals, "goal", ["scenario", "goals"], ctx);
  addDuplicateIdIssues(norms, "norm", ["scenario", "norms"], ctx);
  addDuplicateIdIssues(actions, "action", ["scenario", "actions"], ctx);

  const totalWeight = goals.reduce((sum, goal) => sum + goal.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    ctx.addIssue({
      code: "custom",
      message: "Aggregate goal weight must be finite and positive",
      path: ["scenario", "goals"],
    });
  }

  const goalIds = new Set(goals.map((goal) => goal.id));
  actions.forEach((action, actionIndex) => {
    action.satisfies.forEach((goalId, goalIndex) => {
      if (!goalIds.has(goalId)) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" references unknown goal ID "${goalId}"`,
          path: ["scenario", "actions", actionIndex, "satisfies", goalIndex],
        });
      }
    });
  });

  const actionIds = new Set(actions.map((action) => action.id));
  norms.forEach((norm, index) => {
    if (!actionIds.has(norm.targetAction)) {
      ctx.addIssue({
        code: "custom",
        message: `Norm "${norm.id}" references unknown action ID "${norm.targetAction}"`,
        path: ["scenario", "norms", index, "targetAction"],
      });
    }
  });
  Object.keys(input.evidence).forEach((actionId) => {
    if (!actionIds.has(actionId)) {
      ctx.addIssue({
        code: "custom",
        message: `Evidence references unknown action ID "${actionId}"`,
        path: ["evidence", actionId],
      });
    }
  });
}

export interface GoalChainerInput {
  readonly scenario: GoalScenario;
  readonly evidence: Readonly<Record<string, EvidenceProjectionInput>>;
}

function materializeInput(input: RawGoalChainerInput): GoalChainerInput {
  const scenario = createGoalScenario({
    title: input.scenario.title,
    goals: input.scenario.goals.map(createGoal),
    norms: input.scenario.norms.map(createNorm),
    actions: input.scenario.actions.map(createCandidateAction),
    notes: input.scenario.notes,
  });
  const evidence = Object.freeze(
    Object.fromEntries(
      Object.entries(input.evidence).map(([actionId, projection]) => [
        actionId,
        Object.freeze({
          ...projection,
          proofs: Object.freeze([...projection.proofs]),
        }),
      ]),
    ),
  );
  return Object.freeze({ scenario, evidence });
}

function preflightInput(input: unknown): void {
  assertPlainRecord(input, "GoalChainer input");
  const root = input as Readonly<Record<string, unknown>>;
  assertNoInheritedKeys(root, "GoalChainer input", ["scenario", "evidence"]);
  assertPlainRecord(root.scenario, "GoalChainer input scenario");
  const scenario = root.scenario as Readonly<Record<string, unknown>>;
  assertNoInheritedKeys(scenario, "GoalChainer input scenario", [
    "title",
    "goals",
    "norms",
    "actions",
    "notes",
  ]);
  for (const field of ["goals", "norms", "actions"] as const) {
    const rows = scenario[field];
    assertDenseArray(rows, `GoalChainer input scenario.${field}`);
    rows.forEach((value, index) => {
      assertPlainRecord(value, `GoalChainer input scenario.${field}[${index}]`);
      const known = field === "goals"
        ? ["id", "owner", "statement", "weight", "kind", "required"]
        : field === "norms"
          ? ["id", "mode", "targetAction", "reason", "priority"]
          : [
              "id",
              "label",
              "description",
              "satisfies",
              "evidenceQuery",
              "evidenceAtoms",
              "defaultStrength",
              "defaultConfidence",
            ];
      assertNoInheritedKeys(
        value,
        `GoalChainer input scenario.${field}[${index}]`,
        known,
      );
    });
  }
  if (scenario.notes !== undefined) {
    assertDenseArray(scenario.notes, "GoalChainer input scenario.notes");
  }
  const actions = scenario.actions;
  assertDenseArray(actions, "GoalChainer input scenario.actions");
  actions.forEach((value, index) => {
    const action = value as Readonly<Record<string, unknown>>;
    assertDenseArray(action.satisfies, `GoalChainer input scenario.actions[${index}].satisfies`);
    if (action.evidenceAtoms !== undefined) {
      assertDenseArray(
        action.evidenceAtoms,
        `GoalChainer input scenario.actions[${index}].evidenceAtoms`,
      );
    }
  });
  if (root.evidence !== undefined) {
    assertPlainRecord(root.evidence, "GoalChainer input evidence");
    for (const [actionId, value] of Object.entries(root.evidence)) {
      assertPlainRecord(value, `GoalChainer input evidence.${actionId}`);
      const evidence = value as Readonly<Record<string, unknown>>;
      assertNoInheritedKeys(evidence, `GoalChainer input evidence.${actionId}`, [
        "strength",
        "confidence",
        "source",
        "projection",
        "proofs",
        "deontic",
        "expectation",
      ]);
      if (evidence.proofs !== undefined) {
        assertDenseArray(evidence.proofs, `GoalChainer input evidence.${actionId}.proofs`);
      }
    }
  }
}

const preflightedInputSchema = z.preprocess((input, ctx) => {
  try {
    preflightInput(input);
    return input;
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
}, rawGoalChainerInputSchema);

/** Validate unknown structured input and materialize frozen framework models. */
export const goalChainerInputSchema = preflightedInputSchema
  .superRefine(checkReferences)
  .transform(materializeInput);

/** Pascal-case alias for callers that name schema values after their output type. */
export const GoalChainerInputSchema = goalChainerInputSchema;

export type GoalChainerInputSource = z.input<typeof goalChainerInputSchema>;

export function parseGoalChainerInput(input: unknown): GoalChainerInput {
  return goalChainerInputSchema.parse(input);
}
