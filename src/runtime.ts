// Run MeTTa programs on @metta-ts (pure-TypeScript MeTTa), in-process.
//
// This is the analogue of goal_chainer/petta_runtime.py, which shells out to
// `swipl main.pl -- file.metta`. Here there is no subprocess and no SWI-Prolog:
// a fresh @metta-ts MeTTa instance evaluates the program and we read each
// `!`-query's results back as formatted MeTTa text, one string per result, the
// same surface the Python parsed off PeTTa's stdout lines.
//
// Where the original libraries called registered SWI-Prolog kernels for the
// float arithmetic (grounding.pl, reason.pl, the truth-value formulas), the
// engines here register small TypeScript grounded operations instead. The
// symbolic reasoning (matching facts to rules, firing defeasible rules, folding
// the deontic dominance, chaining deductions) runs as MeTTa on @metta-ts.

import { MeTTa } from "@metta-ts/hyperon";

export type RegisterOps = (metta: MeTTa) => void;

/** Run a program and return one group of result strings per `!`-query. */
export function runMettaGroups(program: string, register?: RegisterOps): string[][] {
  const metta = new MeTTa();
  if (register) register(metta);
  const groups = metta.run(program);
  return groups.map((group) => group.map((atom) => String(atom)));
}

/** Run a program and return every result string flattened, like PeTTa stdout lines. */
export function runMettaLines(program: string, register?: RegisterOps): string[] {
  return runMettaGroups(program, register)
    .flat()
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
