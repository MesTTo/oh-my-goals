// Optional live SWI-Prolog parity through the MeTTa-TS Prolog bridge.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { names } from "@metta-ts/edsl";
import { importPrologFunctionsFromFile } from "@metta-ts/edsl/prolog";
import {
  decideActions,
  validateDecideActionRows,
  type DecideActionRow,
  type NativeDecision,
} from "./native_score.js";
import { mettaDB } from "./engine.js";
import { resolvePrologExecutable } from "./prolog_runtime.js";
import { assertKnownKeys, assertPlainRecord } from "./records.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCORE_PROGRAM = resolve(PACKAGE_ROOT, "assets", "gc_score.pl");
const VALID_STATUSES = new Set(["blocked", "recommended", "candidate", "weak"]);

export interface PrologScoreParityRow {
  input: DecideActionRow;
  metta: NativeDecision;
  prolog: NativeDecision;
  matches: boolean;
}

export interface PrologScoreOptions {
  readonly programPath?: string;
  readonly executable?: string;
}

function validatedOptions(options: PrologScoreOptions): Required<PrologScoreOptions> {
  assertPlainRecord(options, "Prolog score options");
  assertKnownKeys(options, "Prolog score options", ["programPath", "executable"]);
  const requestedProgramPath = options.programPath === undefined
    ? DEFAULT_SCORE_PROGRAM
    : options.programPath;
  const executable = options.executable === undefined ? "" : options.executable;
  if (typeof requestedProgramPath !== "string" || requestedProgramPath.trim() === "") {
    throw new TypeError("Prolog programPath must be a nonblank string");
  }
  if (typeof executable !== "string" || (options.executable !== undefined && executable.trim() === "")) {
    throw new TypeError("Prolog executable must be a nonblank string");
  }
  return { programPath: resolve(requestedProgramPath), executable };
}

function snapshotRows(rows: readonly DecideActionRow[]): readonly DecideActionRow[] {
  validateDecideActionRows(rows);
  return Object.freeze(
    rows.map((row) => Object.freeze([...row]) as DecideActionRow),
  );
}

/** Evaluate score rows through a `.pl` file imported into MeTTa-TS. */
export async function decideActionsWithProlog(
  rows: readonly DecideActionRow[],
  options: PrologScoreOptions = {},
): Promise<NativeDecision[]> {
  const stableRows = snapshotRows(rows);
  const stableOptions = validatedOptions(options);
  if (stableRows.length === 0) return [];
  const executable = resolvePrologExecutable(
    stableOptions.executable === "" ? "swipl" : stableOptions.executable,
  );
  const [{ registerPrologInterop }, { swiPrologBridge }] = await Promise.all([
    import("@metta-ts/prolog"),
    import("@metta-ts/prolog/swi-node"),
  ]);
  const bridge = swiPrologBridge({ executable });
  const p = names<"gc_score" | "gc_decision_status">();
  const statusNames = names();
  try {
    const db = mettaDB();
    registerPrologInterop(db.metta, bridge);
    const imported = await db.evalJsAsync(
      importPrologFunctionsFromFile(stableOptions.programPath, [
        "gc_score",
        "gc_decision_status",
      ]),
    );
    if (imported[0] !== "True") {
      throw new Error(`failed to import Prolog score functions: ${JSON.stringify(imported)}`);
    }
    const results: NativeDecision[] = [];
    for (const row of stableRows) {
      const deontic = statusNames[row[0]]!;
      const scoreResults = await db.evalJsAsync(
        p.gc_score(deontic, row[1], row[2], row[3]),
      );
      if (scoreResults.length !== 1) {
        throw new Error(
          `Prolog returned ${scoreResults.length} score results, expected exactly one`,
        );
      }
      const score = scoreResults[0];
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(`Prolog returned invalid score: ${JSON.stringify(score)}`);
      }
      const statusResults = await db.evalJsAsync(
        p.gc_decision_status(deontic, score, row[4]),
      );
      if (statusResults.length !== 1) {
        throw new Error(
          `Prolog returned ${statusResults.length} decision-status results, expected exactly one`,
        );
      }
      const status = statusResults[0];
      if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
        throw new Error(`Prolog returned invalid decision status: ${JSON.stringify(status)}`);
      }
      results.push([score, status as NativeDecision[1]]);
    }
    return results;
  } finally {
    await bridge.dispose();
  }
}

/** Compare native MeTTa rules with the live Prolog relations row by row. */
export async function verifyScorePrologParity(
  rows: readonly DecideActionRow[],
  options: PrologScoreOptions = {},
): Promise<{ passed: boolean; programPath: string; rows: PrologScoreParityRow[] }> {
  const stableRows = snapshotRows(rows);
  const stableOptions = validatedOptions(options);
  if (stableRows.length === 0) {
    throw new RangeError("score parity verification requires at least one row");
  }
  const metta = decideActions(stableRows);
  const prolog = await decideActionsWithProlog(stableRows, {
    programPath: stableOptions.programPath,
    ...(stableOptions.executable === "" ? {} : { executable: stableOptions.executable }),
  });
  const compared = stableRows.map((input, index) => {
    const mettaResult = metta[index]!;
    const prologResult = prolog[index]!;
    return {
      input,
      metta: mettaResult,
      prolog: prologResult,
      matches:
        Math.abs(mettaResult[0] - prologResult[0]) <= 1e-12 &&
        mettaResult[1] === prologResult[1],
    };
  });
  return {
    passed: compared.every((row) => row.matches),
    programPath: stableOptions.programPath,
    rows: compared,
  };
}
