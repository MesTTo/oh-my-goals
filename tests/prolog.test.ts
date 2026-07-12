import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecideActionRow } from "../src/native_score.js";
import { decideActionsWithProlog, verifyScorePrologParity } from "../src/prolog.js";

const HAS_SWIPL = spawnSync("swipl", ["--version"], { encoding: "utf8" }).status === 0;

describe("live score Prolog parity", () => {
  it("returns an empty batch without starting or locating SWI-Prolog", async () => {
    await expect(
      decideActionsWithProlog([], { executable: "/definitely/missing/swipl" }),
    ).resolves.toEqual([]);
  });

  it("rejects vacuous verification and malformed options", async () => {
    await expect(verifyScorePrologParity([])).rejects.toThrow(
      "requires at least one row",
    );
    await expect(
      decideActionsWithProlog([], { executable: 7 as any }),
    ).rejects.toThrow("executable must be a nonblank string");
    await expect(
      decideActionsWithProlog([], { programPath: "" }),
    ).rejects.toThrow("programPath must be a nonblank string");
    await expect(
      decideActionsWithProlog([], { programPat: "assets/gc_score.pl" } as any),
    ).rejects.toThrow("Prolog score options contains unknown fields: programPat");
  });

  it.runIf(HAS_SWIPL)("snapshots rows before asynchronous Prolog evaluation", async () => {
    const row = ["permitted", 1, 1, 1, 0] as DecideActionRow;
    const pending = decideActionsWithProlog([row]);
    (row as any)[1] = 100;

    await expect(pending).resolves.toEqual([[0.92, "recommended"]]);
  });

  it.runIf(HAS_SWIPL)("matches every verdict branch and threshold boundary", async () => {
    const atRecommended = 9 / 19;
    const atCandidate = 23 / 38;
    const rows = [
      ["forbidden", 1, 1, 1, 0],
      ["conflict", 1, 1, 1, 0],
      ["permitted", atRecommended, 1, 1, 0],
      ["permitted", atRecommended - 1e-6, 1, 1, 0],
      ["permitted", atCandidate, 1, 0.5, 0],
      ["permitted", atCandidate - 1e-6, 1, 0.5, 0],
      ["obligated", 1, 1, 1, 1],
    ] as const satisfies readonly DecideActionRow[];

    const result = await verifyScorePrologParity(rows);
    expect(result.passed).toBe(true);
    expect(isAbsolute(result.programPath)).toBe(true);
    expect(result.rows.map((row) => row.prolog[1])).toEqual([
      "blocked",
      "blocked",
      "recommended",
      "candidate",
      "candidate",
      "weak",
      "candidate",
    ]);
  });
});
