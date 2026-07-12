// Evidence projections used by the generic decision engine.

import { add, mul, sub } from "@metta-ts/edsl";
import { mettaDB, num, type MettaDB } from "./engine.js";
import {
  createCandidateAction,
  createEvidenceProjection,
  type CandidateAction,
  type DeonticStatus,
  type EvidenceProjection,
  type EvidenceProjectionInput,
} from "./models.js";
import type { Belief, PlnResult } from "./pln.js";
import {
  assertDenseArray,
  assertKnownKeys,
  assertPlainRecord,
  finiteProbability,
  ownValue,
} from "./records.js";
import type { EvidenceReasoner } from "./score.js";
import { parseStv, type Stv } from "./truth_value.js";

const DEONTIC_STATUSES: ReadonlySet<string> = new Set([
  "unregulated",
  "permitted",
  "obligated",
  "forbidden",
  "conflict",
]);

export type EvidenceByAction = Readonly<Record<string, EvidenceProjectionInput>>;

function expectation(db: MettaDB, strength: number, confidence: number): number {
  return num(db, add(mul(confidence, sub(strength, 0.5)), 0.5));
}

function projection(
  db: MettaDB,
  action: CandidateAction,
  input: EvidenceProjectionInput | undefined,
  defaultSource: string,
): EvidenceProjection {
  const strength = finiteProbability(
    input === undefined || input.strength === undefined
      ? action.defaultStrength
      : input.strength,
    `evidence.${action.id}.strength`,
  );
  const confidence = finiteProbability(
    input === undefined || input.confidence === undefined
      ? action.defaultConfidence
      : input.confidence,
    `evidence.${action.id}.confidence`,
  );
  const deontic = input === undefined || input.deontic === undefined
    ? "unregulated"
    : input.deontic;
  if (!DEONTIC_STATUSES.has(deontic)) {
    throw new RangeError(`evidence.${action.id}.deontic is unsupported: ${deontic}`);
  }
  const evidence = createEvidenceProjection({
    strength,
    confidence,
    source: input === undefined || input.source === undefined ? defaultSource : input.source,
    projection: input === undefined || input.projection === undefined ? null : input.projection,
    proofs: input === undefined || input.proofs === undefined ? [] : input.proofs,
    deontic,
    expectation: finiteProbability(
      input === undefined || input.expectation === undefined
        ? expectation(db, strength, confidence)
        : input.expectation,
      `evidence.${action.id}.expectation`,
    ),
  });
  assertProjectionAgreement(
    [evidence.strength, evidence.confidence],
    parseStv(evidence.projection),
    `evidence.${action.id}`,
  );
  return evidence;
}

/** Project caller-supplied evidence, falling back to each action's declared
 * default truth value. */
export class StaticEvidenceReasoner implements EvidenceReasoner {
  readonly source: string;
  private readonly db = mettaDB();
  private readonly evidence: EvidenceByAction;

  constructor(
    evidence: EvidenceByAction = {},
    source = "static evidence",
  ) {
    assertPlainRecord(evidence, "static evidence");
    if (typeof source !== "string" || source.trim() === "") {
      throw new TypeError("static evidence reasoner source must be a nonblank string");
    }
    this.evidence = Object.freeze(
      Object.fromEntries(
        Object.entries(evidence).map(([actionId, value]) => {
          if (actionId.trim() === "") throw new TypeError("static evidence action IDs must not be blank");
          assertPlainRecord(value, `static evidence.${actionId}`);
          assertKnownKeys(value, `static evidence.${actionId}`, [
            "strength",
            "confidence",
            "source",
            "projection",
            "proofs",
            "deontic",
            "expectation",
          ]);
          const raw = value as unknown as EvidenceProjectionInput;
          const validated = createEvidenceProjection(raw);
          return [
            actionId,
            Object.freeze({
              strength: validated.strength,
              confidence: validated.confidence,
              source: validated.source,
              projection: validated.projection,
              proofs: validated.proofs,
              ...(raw.deontic === undefined ? {} : { deontic: validated.deontic }),
              ...(raw.expectation === undefined ? {} : { expectation: validated.expectation }),
            }),
          ];
        }),
      ),
    );
    this.source = source;
  }

  project(action: CandidateAction): EvidenceProjection {
    const stableAction = createCandidateAction(action);
    const input = ownValue(this.evidence, stableAction.id);
    return projection(
      this.db,
      stableAction,
      input,
      input === undefined ? "declared action default" : this.source,
    );
  }
}

/** Project beliefs produced by the generic PLN engine. */
export class PlnEvidenceReasoner implements EvidenceReasoner {
  readonly source = "PLN on @metta-ts";
  private readonly db = mettaDB();
  private readonly beliefs: Readonly<Record<string, Readonly<Belief>>>;

  constructor(beliefs: Readonly<Record<string, Belief>>) {
    assertPlainRecord(beliefs, "PLN beliefs");
    this.beliefs = Object.freeze(
      Object.fromEntries(
        Object.entries(beliefs).map(([actionId, belief]) => {
          if (actionId.trim() === "") throw new TypeError("PLN belief action IDs must not be blank");
          assertPlainRecord(belief, `PLN beliefs.${actionId}`);
          assertKnownKeys(belief, `PLN beliefs.${actionId}`, ["strength", "confidence", "proof"]);
          const strength = finiteProbability(belief.strength, `beliefs.${actionId}.strength`);
          const confidence = finiteProbability(belief.confidence, `beliefs.${actionId}.confidence`);
          if (typeof belief.proof !== "string" || belief.proof.trim() === "") {
            throw new TypeError(`beliefs.${actionId}.proof must be a nonblank string`);
          }
          return [actionId, Object.freeze({ strength, confidence, proof: belief.proof })];
        }),
      ),
    );
  }

  static from(result: PlnResult): PlnEvidenceReasoner {
    assertPlainRecord(result, "PLN result");
    assertKnownKeys(result, "PLN result", [
      "actionIds",
      "beliefs",
      "deductionProgram",
      "rawOutputs",
      "proofOutputs",
    ]);
    return new PlnEvidenceReasoner(result.beliefs);
  }

  project(action: CandidateAction): EvidenceProjection {
    const stableAction = createCandidateAction(action);
    const belief = ownValue(this.beliefs, stableAction.id);
    if (belief === undefined) {
      throw new Error(`PLN returned no evidence for action: ${stableAction.id}`);
    }
    const strength = finiteProbability(belief.strength, `beliefs.${stableAction.id}.strength`);
    const confidence = finiteProbability(belief.confidence, `beliefs.${stableAction.id}.confidence`);
    return createEvidenceProjection({
      strength,
      confidence,
      source: this.source,
      projection: `(Acceptable ${JSON.stringify(stableAction.id)}) (STV ${String(strength)} ${String(confidence)})`,
      proofs: [belief.proof],
      deontic: "unregulated",
      expectation: expectation(this.db, strength, confidence),
    });
  }
}

export interface ContextualQueryRequest {
  readonly actionId: string;
  readonly query: string;
  readonly atoms: readonly string[];
}

export interface ContextualQueryResult {
  readonly strength?: number;
  readonly confidence?: number;
  readonly source?: string;
  readonly projection?: string | null;
  readonly proofs?: readonly string[];
  readonly deontic?: DeonticStatus;
  readonly expectation?: number;
}

export type ContextualQueryAdapter = (request: ContextualQueryRequest) => ContextualQueryResult;

function explicitTruthValue(result: ContextualQueryResult): Stv | null {
  const hasStrength = result.strength !== undefined;
  const hasConfidence = result.confidence !== undefined;
  if (hasStrength !== hasConfidence) {
    throw new TypeError("contextual query must return both strength and confidence");
  }
  return hasStrength ? [result.strength!, result.confidence!] : null;
}

function assertProjectionAgreement(
  explicit: Stv | null,
  projected: Stv | null,
  path: string,
): void {
  if (projected !== null) {
    finiteProbability(projected[0], `${path} projection strength`);
    finiteProbability(projected[1], `${path} projection confidence`);
  }
  if (
    explicit !== null &&
    projected !== null &&
    (Math.abs(explicit[0] - projected[0]) > 1e-12 ||
      Math.abs(explicit[1] - projected[1]) > 1e-12)
  ) {
    throw new RangeError(
      `${path} explicit truth value disagrees with its projection STV`,
    );
  }
}

/** Project an action through a caller-injected contextual query engine. */
export class ContextualQueryEvidenceReasoner implements EvidenceReasoner {
  constructor(
    readonly source: string,
    private readonly queryAdapter: ContextualQueryAdapter,
  ) {
    if (typeof source !== "string" || source.trim() === "") {
      throw new RangeError("contextual query source must not be empty");
    }
    if (typeof queryAdapter !== "function") {
      throw new TypeError("contextual query adapter must be a function");
    }
  }

  project(action: CandidateAction): EvidenceProjection {
    const stableAction = createCandidateAction(action);
    if (stableAction.evidenceQuery.trim() === "") {
      throw new RangeError(`action has no contextual evidence query: ${stableAction.id}`);
    }
    const result = this.queryAdapter(
      Object.freeze({
        actionId: stableAction.id,
        query: stableAction.evidenceQuery,
        atoms: Object.freeze([...stableAction.evidenceAtoms]),
      }),
    );
    assertPlainRecord(result, "contextual query result");
    assertKnownKeys(result, "contextual query result", [
      "strength",
      "confidence",
      "source",
      "projection",
      "proofs",
      "deontic",
      "expectation",
    ]);
    const proofs = result.proofs === undefined ? [] : result.proofs;
    assertDenseArray(proofs, "contextual query proofs");
    proofs.forEach((proof, index) => {
      if (typeof proof !== "string") {
        throw new TypeError(`contextual query proofs[${index}] must be a string`);
      }
    });
    if (
      result.projection !== undefined &&
      result.projection !== null &&
      typeof result.projection !== "string"
    ) {
      throw new TypeError("contextual query projection must be a string or null");
    }
    const frozenProofs = Object.freeze([...proofs]);
    const explicit = explicitTruthValue(result);
    const projected = parseStv(result.projection);
    assertProjectionAgreement(explicit, projected, "contextual query");
    const truthValue = explicit ?? projected;
    if (truthValue === null) {
      throw new Error(`contextual query returned no truth value for action: ${stableAction.id}`);
    }
    const source = result.source ?? this.source;
    return projection(
      mettaDB(),
      stableAction,
      {
        strength: truthValue[0],
        confidence: truthValue[1],
        source,
        projection: result.projection ?? null,
        proofs: frozenProofs,
        deontic: result.deontic,
        expectation: result.expectation,
      },
      source,
    );
  }
}
