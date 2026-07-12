// Load the GoalChainer MeTTa module and call its public relations.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  expr,
  gfloat,
  gint,
  gstr,
  parseAll,
  standardTokenizer,
  type TopAtom,
} from "@metta-ts/core";
import { ground, type Term } from "@metta-ts/edsl";
import {
  atomToJs,
  Atom,
  E,
  ExpressionAtom,
  GroundedAtom,
  MeTTa,
  S,
} from "@metta-ts/hyperon";
import { pythonFloatSum, roundN } from "./rounding.js";
import { registerGoalChainerBulkOperations } from "./metta_bulk.js";

const MODULE_URL = new URL("../metta/goalchainer.metta", import.meta.url);
let moduleSource: string | undefined;
let moduleAtoms: readonly TopAtom[] | undefined;

function source(): string {
  moduleSource ??= readFileSync(fileURLToPath(MODULE_URL), "utf8");
  return moduleSource;
}

function programAtoms(): readonly TopAtom[] {
  if (moduleAtoms === undefined) {
    const parsed = parseAll(source(), standardTokenizer());
    if (parsed.some((top) => top.bang)) {
      throw new Error("goalchainer.metta must not contain top-level queries");
    }
    moduleAtoms = Object.freeze(parsed.map((top) => Object.freeze(top)));
  }
  return moduleAtoms;
}

/** An isolated fact set evaluated with the optimized MeTTa TS program runner. */
export class GoalChainerMetta {
  private readonly runner = new MeTTa();

  constructor() {
    const numericVector = (atom: Atom, name: string): number[] => {
      const value = atomToJs(atom);
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
      ) {
        throw new TypeError(`${name} expects a finite numeric expression`);
      }
      return value as number[];
    };
    this.runner.registerOperation("gc-vector-sum-atom", (args) => {
      if (args.length !== 1) throw new TypeError("gc-vector-sum-atom expects one argument");
      const result = pythonFloatSum(numericVector(args[0]!, "gc-vector-sum-atom"));
      if (!Number.isFinite(result)) {
        throw new RangeError("gc-vector-sum-atom result must be finite");
      }
      return [mettaFloat(result)];
    });
    this.runner.registerOperation("gc-vector-dot-atom", (args) => {
      if (args.length !== 2) throw new TypeError("gc-vector-dot-atom expects two arguments");
      const left = numericVector(args[0]!, "gc-vector-dot-atom");
      const right = numericVector(args[1]!, "gc-vector-dot-atom");
      if (left.length !== right.length) {
        throw new RangeError("gc-vector-dot-atom vectors must have equal length");
      }
      const result = pythonFloatSum(left.map((value, index) => value * right[index]!));
      if (!Number.isFinite(result)) {
        throw new RangeError("gc-vector-dot-atom result must be finite");
      }
      return [mettaFloat(result)];
    });
    this.runner.registerOperation("gc-goal-mask-atom", (args) => {
      if (args.length !== 2) throw new TypeError("gc-goal-mask-atom expects two arguments");
      const selectedKind = atomToJs(args[0]!);
      const goals = atomToJs(args[1]!);
      if (
        (selectedKind !== "individual" && selectedKind !== "collective") ||
        !Array.isArray(goals)
      ) {
        throw new TypeError("gc-goal-mask-atom expects a goal kind and goal expression");
      }
      const mask = goals.map((goal, index) => {
        if (
          !Array.isArray(goal) ||
          goal.length !== 5 ||
          goal[0] !== "Goal" ||
          (goal[2] !== "individual" && goal[2] !== "collective")
        ) {
          throw new TypeError(`gc-goal-mask-atom received an invalid goal at index ${index}`);
        }
        return goal[2] === selectedKind ? 1 : 0;
      });
      return [mettaTuple(mask.map(mettaFloat))];
    });
    this.runner.registerOperation("gc-correlation-values-atom", (args) => {
      if (args.length !== 1) {
        throw new TypeError("gc-correlation-values-atom expects one argument");
      }
      const specs = atomToJs(args[0]!);
      if (!Array.isArray(specs)) {
        throw new TypeError("gc-correlation-values-atom expects a correlation expression");
      }
      const values = specs.map((spec, index) => {
        if (!Array.isArray(spec) || spec.length !== 2) {
          throw new TypeError(
            `gc-correlation-values-atom received an invalid specification at index ${index}`,
          );
        }
        if (
          spec[0] === "ExplicitCorrelation" &&
          typeof spec[1] === "number" &&
          Number.isFinite(spec[1]) &&
          spec[1] >= -1 &&
          spec[1] <= 1
        ) {
          return spec[1];
        }
        if (spec[0] === "DefaultCorrelation" && typeof spec[1] === "boolean") {
          return spec[1] ? 1 : 0;
        }
        throw new TypeError(
          `gc-correlation-values-atom received an invalid specification at index ${index}`,
        );
      });
      return [mettaTuple(values.map(mettaFloat))];
    });
    this.runner.registerOperation("gc-round-number-atom", (args) => {
      if (args.length !== 2) throw new TypeError("gc-round-number-atom expects two arguments");
      const value = atomToJs(args[0]!);
      const digits = atomToJs(args[1]!);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        typeof digits !== "number" ||
        !Number.isSafeInteger(digits)
      ) {
        throw new TypeError("gc-round-number-atom expects a finite number and integer digits");
      }
      return [mettaFloat(roundN(value, digits))];
    });
    this.runner.registerOperation("gc-affine-normalize-atom", (args) => {
      if (args.length !== 5) {
        throw new TypeError("gc-affine-normalize-atom expects five arguments");
      }
      const values = atomToJs(args[0]!);
      const scaledLow = atomToJs(args[1]!);
      const scaledSpan = atomToJs(args[2]!);
      const scale = atomToJs(args[3]!);
      const equal = atomToJs(args[4]!);
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        typeof scaledLow !== "number" ||
        !Number.isFinite(scaledLow) ||
        typeof scaledSpan !== "number" ||
        !Number.isFinite(scaledSpan) ||
        typeof scale !== "number" ||
        !Number.isFinite(scale) ||
        typeof equal !== "boolean"
      ) {
        throw new TypeError("gc-affine-normalize-atom expects finite numeric inputs");
      }
      if (!equal && (scale <= 0 || scaledSpan <= 0)) {
        throw new RangeError("gc-affine-normalize-atom requires a positive scale and span");
      }
      const normalized = values.map((value) => {
        if (equal) return 1;
        return Math.max(0, Math.min(1, (value / scale - scaledLow) / scaledSpan));
      });
      return [mettaTuple(normalized.map(mettaFloat))];
    });
    registerGoalChainerBulkOperations(this.runner);
    for (const top of programAtoms()) {
      this.runner.space().addAtom(Atom.fromCAtom(top.atom));
    }
  }

  add(...terms: readonly Term[]): this {
    for (const term of terms) this.runner.space().addAtom(ground(term));
    return this;
  }

  remove(term: Term): boolean {
    return this.runner.space().removeAtom(ground(term));
  }

  evalMany(terms: readonly Term[]): Atom[][] {
    return terms.map((term) => this.runner.evaluateAtom(ground(term)));
  }

  eval(term: Term): Atom[] {
    return this.evalMany([term])[0]!;
  }

  evalJs(term: Term): unknown[] {
    return this.eval(term).map(atomToJs);
  }

  evalJsMany(terms: readonly Term[]): unknown[][] {
    return this.evalMany(terms).map((group) => group.map(atomToJs));
  }
}

/** Create an isolated MeTTa fact set. */
export function createGoalChainerMetta(): GoalChainerMetta {
  return new GoalChainerMetta();
}

let sharedEvaluator: GoalChainerMetta | undefined;

/** Reuse the immutable framework rule space for pure relation calls. */
export function sharedGoalChainerMetta(): GoalChainerMetta {
  sharedEvaluator ??= createGoalChainerMetta();
  return sharedEvaluator;
}

/** Build one call into the native GoalChainer module. */
export function mettaCall(name: string, ...args: readonly Term[]): ExpressionAtom {
  return E(S(name), ...args.map(ground));
}

/** Build a MeTTa expression used as an ordered value sequence. */
export function mettaTuple(values: readonly Term[]): ExpressionAtom {
  return new ExpressionAtom(expr(values.map((value) => ground(value).catom)));
}

/** Build a MeTTa symbol after the caller validates its vocabulary. */
export function mettaSymbol(value: string): Atom {
  return S(value);
}

/** Build a finite MeTTa Float. */
export function mettaFloat(value: number): Atom {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("MeTTa float value must be finite");
  }
  return new GroundedAtom(gfloat(value));
}

/** Build a MeTTa Int from a JavaScript safe integer. */
export function mettaInteger(value: number): Atom {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("MeTTa integer value must be a safe integer");
  }
  return new GroundedAtom(gint(value));
}

/** Build a grounded MeTTa String. */
export function mettaString(value: string): Atom {
  if (typeof value !== "string") throw new TypeError("MeTTa string value must be a string");
  return new GroundedAtom(gstr(value));
}

/** Evaluate one native relation and require one deterministic result. */
export function mettaOne(
  db: GoalChainerMetta,
  name: string,
  ...args: readonly Term[]
): unknown {
  const results = db.evalJs(mettaCall(name, ...args));
  if (results.length !== 1) {
    throw new Error(`goalchainer.metta relation ${name} returned ${results.length} results`);
  }
  return results[0];
}

export type { Term };
