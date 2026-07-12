// Subjective-Logic NARS opinions and deduction through goalchainer.metta.

import {
  mettaCall,
  mettaFloat,
  mettaOne,
  mettaString,
  sharedGoalChainerMetta,
} from "./metta.js";
import { round6 } from "./models.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";

const ENGINE = "GoalChainer SNARS deduction in MeTTa TS";
const ASSESS_ENGINE = "GoalChainer SNARS assessment in MeTTa TS";

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

function readOpinion(value: unknown, path: string): Opinion {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== "Opinion" ||
    value.slice(1).some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1,
    )
  ) {
    throw new Error(`goalchainer.metta returned an invalid opinion for ${path}`);
  }
  const [, b, d, u, a] = value as [string, number, number, number, number];
  if (Math.abs(b + d + u - 1) > 1e-12) {
    throw new Error(`goalchainer.metta returned a non-normalized opinion for ${path}`);
  }
  return { b, d, u, a };
}

function readExpectation(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`goalchainer.metta returned an invalid expectation for ${path}`);
  }
  return value;
}

function publicExpectation(opinion: Opinion, path: string): number {
  const value = mettaOne(
    sharedGoalChainerMetta(),
    "gc-opinion-expectation",
    mettaCall(
      "Opinion",
      mettaFloat(opinion.b),
      mettaFloat(opinion.d),
      mettaFloat(opinion.u),
      mettaFloat(opinion.a),
    ),
  );
  return round6(readExpectation(value, path));
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
  const values = sharedGoalChainerMetta().evalJs(mettaCall(
    "gc-snars-assess",
    mettaString(subject),
    mettaString(relation),
    mettaString(object),
    mettaString(source),
    mettaFloat(evidence.positive),
    mettaFloat(evidence.negative),
    mettaFloat(evidence.baseRate),
  ));
  if (values.length !== 1) {
    throw new Error(`goalchainer.metta returned ${values.length} SNARS assessments`);
  }
  const result = values[0];
  if (
    !Array.isArray(result) ||
    result.length !== 7 ||
    result[0] !== "SnarsAssessment" ||
    result[1] !== subject ||
    result[2] !== relation ||
    result[3] !== object ||
    result[4] !== source
  ) {
    throw new Error(`goalchainer.metta returned an invalid SNARS assessment: ${JSON.stringify(result)}`);
  }
  const opinion = roundOpinion(readOpinion(result[5], "assessment"));
  readExpectation(result[6], "assessment native result");
  const expectation = publicExpectation(opinion, "assessment");
  const claim = `${subject} ${relation} ${object}`;
  return {
    claim,
    engine: ASSESS_ENGINE,
    opinion,
    expectation,
    why:
      `(because asserted ((premise ${JSON.stringify(`${claim}.`)} ${opinionString(opinion)})) ` +
      `(:source ${JSON.stringify(source)}))`,
    source,
  };
}

/** Chain two default-prior premises through native subjective-logic deduction. */
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
  const values = sharedGoalChainerMetta().evalJs(mettaCall(
    "gc-snars-deduction",
    mettaString(subject),
    mettaString(middle),
    mettaString(conclusion),
    mettaString(source1),
    mettaString(source2),
  ));
  if (values.length !== 1) {
    throw new Error(`goalchainer.metta returned ${values.length} SNARS deductions, expected one`);
  }
  const result = values[0];
  if (
    !Array.isArray(result) ||
    result.length !== 10 ||
    result[0] !== "SnarsDeduction" ||
    result[1] !== subject ||
    result[2] !== middle ||
    result[3] !== conclusion ||
    result[4] !== source1 ||
    result[5] !== source2
  ) {
    throw new Error(`goalchainer.metta returned an invalid SNARS deduction: ${JSON.stringify(result)}`);
  }
  const premise1 = roundOpinion(readOpinion(result[6], "first premise"));
  const premise2 = roundOpinion(readOpinion(result[7], "second premise"));
  const opinion = roundOpinion(readOpinion(result[8], "deduction"));
  readExpectation(result[9], "deduction native result");
  const expectation = publicExpectation(opinion, "deduction");
  const sentence1 = `${subject} is ${middle}.`;
  const sentence2 = `${middle} is ${conclusion}.`;
  return {
    claim: `${subject} is ${conclusion}`,
    engine: ENGINE,
    derived: true,
    opinion,
    expectation,
    proof: {
      rule: "deduction",
      premises: [
        { statement: sentence1, opinion: premise1, source: source1 },
        { statement: sentence2, opinion: premise2, source: source2 },
      ],
    },
    why:
      `(because ded ((premise ${JSON.stringify(sentence1)} ${opinionString(premise1)}) ` +
      `(premise ${JSON.stringify(sentence2)} ${opinionString(premise2)})) ` +
      `(:sources (${JSON.stringify(source1)} ${JSON.stringify(source2)})))`,
  };
}
