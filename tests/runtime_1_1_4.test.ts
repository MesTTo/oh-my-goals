import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { round6 } from "../src/models.js";
import {
  decideActions,
  scoreActions,
  type DecideActionRow,
  type ScoreActionRow,
} from "../src/native_score.js";
import { assess, derive } from "../src/snars.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("@metta-ts 1.1.4 runtime", () => {
  it("pins the runtime and validation packages exactly", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8")) as {
      packages: Record<string, { version?: string }>;
    };

    const expected = {
      "@metta-ts/core": "1.1.4",
      "@metta-ts/edsl": "1.1.4",
      "@metta-ts/hyperon": "1.1.4",
      "@metta-ts/prolog": "1.1.4",
      zod: "4.4.3",
    };
    expect(manifest.dependencies).toMatchObject(expected);
    for (const [name, version] of Object.entries(expected)) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }

    const testStack = {
      "@metta-ts/node": "1.1.4",
      vite: "6.4.3",
      vitest: "4.1.10",
    };
    expect(manifest.devDependencies).toMatchObject(testStack);
    for (const [name, version] of Object.entries(testStack)) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it("preserves native status selection", () => {
    const rows = [
      ["obligated", 0.9, 0.8, 1, 0],
      ["permitted", 0.75, 0.8, 0.5, 1],
      ["conflict", 1, 1, 1, 0],
    ] as const satisfies readonly DecideActionRow[];

    expect(decideActions(rows)).toEqual([
      [0.9136000000000001, "recommended"],
      [0.49800000000000005, "weak"],
      [-1, "blocked"],
    ]);
  });

  it("preserves the score formula across a deterministic input grid", () => {
    const statuses = [
      "forbidden",
      "conflict",
      "obligated",
      "permitted",
      "unregulated",
    ] as const;
    const values = [0, 0.05, 0.5, 0.934, 1] as const;
    const rows: ScoreActionRow[] = [];
    for (const status of statuses) {
      for (const strength of values) {
        for (const confidence of values) {
          for (const motivation of values) {
            rows.push([status, strength, confidence, motivation]);
          }
        }
      }
    }

    const scores = scoreActions(rows);
    expect(scores).toHaveLength(rows.length);
    scores.forEach((score, index) => {
      const [status, strength, confidence, motivation] = rows[index]!;
      const expected =
        status === "forbidden" || status === "conflict"
          ? -1
          : 0.54 * motivation +
            0.38 * strength * confidence +
            (status === "obligated" ? 0.1 : 0);
      expect(score).toBeCloseTo(expected, 15);
    });
  });

  it("rejects invalid public score rows before evaluation", () => {
    expect(() => scoreActions([["forbiden" as any, 1, 1, 1]])).toThrow(
      "unsupported deontic status",
    );
    expect(() => scoreActions([["permitted", 1.01, 1, 1]])).toThrow(
      "must be finite and within [0, 1]",
    );
    expect(() => decideActions([["permitted", 1, 1, 1, 2 as any]])).toThrow(
      "must be 0 or 1",
    );
    const sparseRows: DecideActionRow[] = [];
    sparseRows.length = 2;
    expect(() => decideActions(sparseRows)).toThrow("rows must not contain holes");
    const sparseRow = ["permitted", 1, 1, 1, 0] as unknown as DecideActionRow;
    delete (sparseRow as any)[2];
    expect(() => decideActions([sparseRow])).toThrow("rows[0] must not contain holes");
  });

  it("preserves SNARS matching and opinion arithmetic", () => {
    expect(assess("storage_write", "violates", "retention_policy", "assertion")).toEqual({
      claim: "storage_write violates retention_policy",
      engine: "GoalChainer SNARS assessment in MeTTa TS",
      opinion: { b: 0.818182, d: 0, u: 0.181818, a: 0.5 },
      expectation: 0.909091,
      why:
        '(because asserted ((premise "storage_write violates retention_policy." (Opinion 0.818182 0.0 0.181818 0.5))) (:source "assertion"))',
      source: "assertion",
    });

    const deduction = derive("storage_write", "risky_operation", "forbidden_operation");
    expect(deduction.opinion).toEqual({ b: 0.669421, d: 0, u: 0.330579, a: 0.5 });
    expect(deduction.expectation).toBe(0.834711);

    expect(() =>
      assess("subject", "relation", "object", "source", {
        positive: Number.MAX_VALUE,
        negative: Number.MAX_VALUE,
      }),
    ).toThrow("combined evidence weight must be finite");
    expect(
      assess("subject", "relation", "object", "source", {
        positive: 0,
        negative: 1,
        baseRate: 0.5,
      }),
    ).toMatchObject({
      opinion: { b: 0, d: 0.333333, u: 0.666667, a: 0.5 },
      expectation: 0.333334,
    });
    const normalizedOpinion = assess("subject", "relation", "object", "source", {
      positive: 2,
      negative: 2,
    }).opinion;
    expect(normalizedOpinion).toEqual({ b: 0.333333, d: 0.333333, u: 0.333334, a: 0.5 });
    expect(normalizedOpinion.b + normalizedOpinion.d + normalizedOpinion.u).toBe(1);
    expect(() =>
      assess("subject", "relation", "object", "source", {
        positive: 1,
        negative: 0,
        baserate: 0.5,
      } as any),
    ).toThrow("SNARS evidence contains unknown fields: baserate");
    expect(() => derive("a", "b", "c", "xy" as any)).toThrow(
      "sources must be an array",
    );
    expect(() => derive("a", "b", "c", ["only"] as any)).toThrow(
      "sources must contain exactly two values",
    );

    const escaped = derive('subject "quoted"\nnext', "middle", "conclusion");
    expect(escaped.why).toContain(JSON.stringify('subject "quoted"\nnext is middle.'));

    const reflexive = derive("same", "same", "same", ["source one", "source two"]);
    expect(reflexive.derived).toBe(true);
    expect(reflexive.proof.premises.map((premise) => premise.source)).toEqual([
      "source one",
      "source two",
    ]);
  });

  it("derives SNARS expectations from the rounded public opinion", () => {
    let state = 0x9e3779b9;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };

    for (let index = 0; index < 128; index += 1) {
      const result = assess("subject", "relation", "object", "source", {
        positive: random() * 100,
        negative: random() * 100,
        baseRate: random(),
      });
      expect(result.expectation).toBe(
        round6(result.opinion.b + result.opinion.a * result.opinion.u),
      );
    }
  });
});
