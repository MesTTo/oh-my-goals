// Subjective-Logic NARS opinions and deduction on @metta-ts.

import { Match, add, div, e, mul, names, sub, vars } from "@metta-ts/edsl";
import { flt, mettaDB, num, type MettaDB } from "./engine.js";
import { round6 } from "./models.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";

const ENGINE = "SNARS deduction (Subjective-Logic NARS) on @metta-ts";
const ASSESS_ENGINE = "SNARS (Subjective-Logic NARS) on @metta-ts";
const n = names<
  | "snars-prior-belief"
  | "snars-prior-disbelief"
  | "snars-prior-uncertainty"
  | "snars-belief"
  | "snars-assess"
  | "snars-assessment"
  | "snars-inheritance"
  | "snars-deduction"
>();
const priorBelief = n["snars-prior-belief"];
const priorDisbelief = n["snars-prior-disbelief"];
const priorUncertainty = n["snars-prior-uncertainty"];
const belief = n["snars-belief"];
const assessClaim = n["snars-assess"];
const assessment = n["snars-assessment"];
const inheritance = n["snars-inheritance"];
const deduction = n["snars-deduction"];
const INITIALIZED_DBS = new WeakSet<MettaDB>();

export interface Opinion {
  b: number;
  d: number;
  u: number;
  a: number;
}

export interface SnarsEvidence {
  positive: number;
  negative: number;
  baseRate?: number;
}

export interface SnarsAssessment {
  claim: string;
  engine: string;
  opinion: Opinion;
  expectation: number;
  why: string;
  source: string;
}

const roundOpinion = (opinion: Opinion): Opinion => {
  const b = round6(opinion.b);
  const d = round6(opinion.d);
  return {
    b,
    d,
    u: round6(Math.max(0, 1 - b - d)),
    a: round6(opinion.a),
  };
};
const pyFloat = (value: number): string =>
  Number.isInteger(value) ? value.toFixed(1) : String(value);
const opinionString = (opinion: Opinion): string =>
  `(Opinion ${pyFloat(opinion.b)} ${pyFloat(opinion.d)} ${pyFloat(opinion.u)} ${pyFloat(opinion.a)})`;

function ensureSnarsRules(db: MettaDB): void {
  if (INITIALIZED_DBS.has(db)) return;
  const q = vars<{
    positive: number;
    negative: number;
    subject: string;
    relation: string;
    object: string;
    source: string;
    baseRate: number;
  }>();
  const total = add(add(q.positive, q.negative), flt(2));
  db.rule(priorBelief(q.positive, q.negative), div(q.positive, total));
  db.rule(priorDisbelief(q.positive, q.negative), div(q.negative, total));
  db.rule(priorUncertainty(q.positive, q.negative), div(flt(2), total));
  db.rule(
    assessClaim(q.subject, q.relation, q.object),
    Match(
      belief(
        q.subject,
        q.relation,
        q.object,
        q.source,
        q.positive,
        q.negative,
        q.baseRate,
      ),
      assessment(
        q.source,
        priorBelief(q.positive, q.negative),
        priorDisbelief(q.positive, q.negative),
        priorUncertainty(q.positive, q.negative),
        q.baseRate,
      ),
    ),
  );
  INITIALIZED_DBS.add(db);
}

function priorOpinion(
  db: MettaDB,
  positive: number,
  negative: number,
  baseRate = 0.5,
): Opinion {
  ensureSnarsRules(db);
  return {
    b: num(db, priorBelief(flt(positive), flt(negative))),
    d: num(db, priorDisbelief(flt(positive), flt(negative))),
    u: num(db, priorUncertainty(flt(positive), flt(negative))),
    a: baseRate,
  };
}

const projectedExpectation = (db: MettaDB, opinion: Opinion): number =>
  num(db, add(opinion.b, mul(opinion.a, opinion.u)));

function nonempty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RangeError(`${path} must not be empty`);
  }
  return value;
}

function validateEvidence(input: SnarsEvidence): Required<SnarsEvidence> {
  assertPlainRecord(input, "SNARS evidence");
  assertKnownKeys(input, "SNARS evidence", ["positive", "negative", "baseRate"]);
  const baseRate = input.baseRate === undefined ? 0.5 : input.baseRate;
  if (!Number.isFinite(input.positive) || input.positive < 0) {
    throw new RangeError("positive evidence must be finite and non-negative");
  }
  if (!Number.isFinite(input.negative) || input.negative < 0) {
    throw new RangeError("negative evidence must be finite and non-negative");
  }
  if (!Number.isFinite(input.positive + input.negative + 2)) {
    throw new RangeError("combined evidence weight must be finite");
  }
  if (!Number.isFinite(baseRate) || baseRate < 0 || baseRate > 1) {
    throw new RangeError("base rate must be finite and within [0, 1]");
  }
  return { positive: input.positive, negative: input.negative, baseRate };
}

/** Assert one claim with weighted positive and negative evidence. */
export function assess(
  subject: string,
  relation: string,
  object: string,
  source = "caller",
  input: SnarsEvidence = { positive: 9, negative: 0 },
): SnarsAssessment {
  nonempty(subject, "subject");
  nonempty(relation, "relation");
  nonempty(object, "object");
  nonempty(source, "source");
  const evidence = validateEvidence(input);
  const db = mettaDB();
  ensureSnarsRules(db);
  db.add(
    belief(
      subject,
      relation,
      object,
      source,
      flt(evidence.positive),
      flt(evidence.negative),
      flt(evidence.baseRate),
    ),
  );
  const result = db.evalJs(assessClaim(subject, relation, object))[0];
  if (!Array.isArray(result) || result.length !== 6) {
    throw new Error(`@metta-ts returned invalid SNARS assessment: ${JSON.stringify(result)}`);
  }
  const [, provenance, b, d, u, a] = result;
  if (
    typeof provenance !== "string" ||
    typeof b !== "number" ||
    typeof d !== "number" ||
    typeof u !== "number" ||
    typeof a !== "number" ||
    ![b, d, u, a].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    Math.abs(b + d + u - 1) > 1e-12
  ) {
    throw new Error(`@metta-ts returned invalid SNARS values: ${JSON.stringify(result)}`);
  }
  const opinion = roundOpinion({ b, d, u, a });
  const claim = `${subject} ${relation} ${object}`;
  return {
    claim,
    engine: ASSESS_ENGINE,
    opinion,
    expectation: round6(projectedExpectation(db, opinion)),
    why:
      `(because asserted ((premise ${JSON.stringify(`${claim}.`)} ${opinionString(opinion)})) ` +
      `(:source ${JSON.stringify(provenance)}))`,
    source: provenance,
  };
}

/** Chain two default-prior premises through subjective-logic deduction. */
export function derive(
  subject: string,
  middle: string,
  conclusion: string,
  sources: readonly [string, string] = ["caller", "policy"],
): {
  claim: string;
  engine: string;
  derived: boolean;
  opinion: Opinion;
  expectation: number;
  proof: {
    rule: string;
    premises: { statement: string; opinion: Opinion; source: string }[];
  };
  why: string;
} {
  nonempty(subject, "subject");
  nonempty(middle, "middle");
  nonempty(conclusion, "conclusion");
  assertDenseArray(sources, "sources");
  if (sources.length !== 2) throw new TypeError("sources must contain exactly two values");
  const source1 = nonempty(sources[0], "sources[0]");
  const source2 = nonempty(sources[1], "sources[1]");
  const db = mettaDB();
  const premise1 = priorOpinion(db, 9, 0);
  const premise2 = priorOpinion(db, 9, 0);
  db.add(
    inheritance(
      subject,
      middle,
      source1,
      premise1.b,
      premise1.d,
      premise1.u,
      premise1.a,
    ),
    inheritance(
      middle,
      conclusion,
      source2,
      premise2.b,
      premise2.d,
      premise2.u,
      premise2.a,
    ),
  );
  const q = vars<{
    subject: string;
    middle: string;
    conclusion: string;
    source1: string;
    source2: string;
    b1: number;
    d1: number;
    u1: number;
    a1: number;
    b2: number;
    d2: number;
    u2: number;
    a2: number;
  }>();
  const derivedBelief = mul(q.b1, q.b2);
  db.rule(
    deduction(q.subject, q.conclusion, q.source1, q.source2),
    Match(
      inheritance(q.subject, q.middle, q.source1, q.b1, q.d1, q.u1, q.a1),
      Match(
        inheritance(q.middle, q.conclusion, q.source2, q.b2, q.d2, q.u2, q.a2),
        e(q.source1, q.source2, derivedBelief, 0, sub(1, derivedBelief), 0.5),
      ),
    ),
  );
  const results = db.evalJs(deduction(subject, conclusion, source1, source2));
  if (results.length !== 1) {
    throw new Error(`@metta-ts returned ${results.length} SNARS deductions, expected one`);
  }
  const result = results[0];
  if (
    !Array.isArray(result) ||
    result.length !== 6 ||
    typeof result[0] !== "string" ||
    typeof result[1] !== "string" ||
    !result.slice(2).every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error(`@metta-ts returned invalid SNARS deduction: ${String(result)}`);
  }
  const [, , b, d, u, a] = result as [string, string, number, number, number, number];
  const opinion = roundOpinion({ b, d, u, a });
  const roundedPremise1 = roundOpinion(premise1);
  const roundedPremise2 = roundOpinion(premise2);
  const sentence1 = `${subject} is ${middle}.`;
  const sentence2 = `${middle} is ${conclusion}.`;
  return {
    claim: `${subject} is ${conclusion}`,
    engine: ENGINE,
    derived: true,
    opinion,
    expectation: round6(projectedExpectation(db, opinion)),
    proof: {
      rule: "deduction",
      premises: [
        { statement: sentence1, opinion: roundedPremise1, source: source1 },
        { statement: sentence2, opinion: roundedPremise2, source: source2 },
      ],
    },
    why:
      `(because ded ((premise ${JSON.stringify(sentence1)} ${opinionString(roundedPremise1)}) ` +
      `(premise ${JSON.stringify(sentence2)} ${opinionString(roundedPremise2)})) ` +
      `(:sources (${JSON.stringify(source1)} ${JSON.stringify(source2)})))`,
  };
}
