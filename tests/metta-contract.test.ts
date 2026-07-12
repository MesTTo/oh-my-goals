import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format, parseAll, standardTokenizer } from "@metta-ts/core";
import { runFile } from "@metta-ts/node";
import { describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT = join(ROOT, "tests", "oh-my-goals-contract.metta");

describe("native Oh My Goals MeTTa contract", () => {
  it("loads the framework and satisfies every executable assertion", () => {
    const results = runFile(CONTRACT, 1_000_000);
    const queryCount = parseAll(readFileSync(CONTRACT, "utf8"), standardTokenizer())
      .filter(({ bang }) => bang)
      .length;

    expect(results).toHaveLength(queryCount);
    expect(results.map(({ results: atoms }) => atoms.map((atom) => format(atom)))).toEqual(
      Array.from({ length: queryCount }, () => ["()"]),
    );
  });
});
