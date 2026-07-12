import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadColoreContext } from "../src/ontology.js";

const FIXTURE = [
  "; focused COLORE fixture",
  '(colore module timepoints/lp_ordering "https://example.test/time")',
  "(colore pred timepoints/lp_ordering before 2)",
  "(colore axiom timepoints/lp_ordering a1 horn (forall ($x $y $z) (if (and (timepoint $x) (timepoint $y) (timepoint $z) (before $x $y) (before $y $z)) (before $x $z))))",
  '(colore gloss timepoints/lp_ordering a1 "before is transitive")',
  '(colore module unrelated "https://example.test/unrelated")',
  "(colore axiom unrelated u1 theorem (unrelated x))",
].join("\n");

describe("COLORE source selection", () => {
  let root: string;
  let fixturePath: string;
  let previousEnvironment: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goalchainer-ontology-test-"));
    fixturePath = join(root, "data-colore.metta");
    writeFileSync(fixturePath, FIXTURE, "utf-8");
    previousEnvironment = process.env.GOALCHAINER_COLORE_PATH;
    delete process.env.GOALCHAINER_COLORE_PATH;
  });

  afterEach(() => {
    if (previousEnvironment === undefined) {
      delete process.env.GOALCHAINER_COLORE_PATH;
    } else {
      process.env.GOALCHAINER_COLORE_PATH = previousEnvironment;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("parses an explicit filesystem path", () => {
    const context = loadColoreContext(fixturePath);

    expect(context).toMatchObject({
      source_path: fixturePath,
      source_available: true,
      module_count: 2,
      axiom_count: 2,
      predicate_count: 1,
      gloss_count: 1,
      axiom_kinds: { horn: 1, theorem: 1 },
    });
    expect(context.selected_axioms).toEqual([
      {
        source: "timepoints/lp_ordering/a1",
        module: "timepoints/lp_ordering",
        axiom_id: "a1",
        kind: "horn",
        expression: "(forall ($x $y $z) (if (and (timepoint $x) (timepoint $y) (timepoint $z) (before $x $y) (before $y $z)) (before $x $z)))",
        gloss: "before is transitive",
      },
    ]);
    expect(context.projection_rules.map((rule) => rule.available)).toEqual([true, false, false]);
  });

  it("accepts file URLs and reports the resolved filesystem path", () => {
    const context = loadColoreContext(pathToFileURL(fixturePath));
    expect(context.source_available).toBe(true);
    expect(context.source_path).toBe(fixturePath);
  });

  it("does not enable a hard-coded projection for a spoofed axiom key", () => {
    writeFileSync(
      fixturePath,
      FIXTURE.replace(
        "a1 horn (forall ($x $y $z) (if (and (timepoint $x) (timepoint $y) (timepoint $z) (before $x $y) (before $y $z)) (before $x $z)))",
        "a1 unrelated (not (before x z))",
      ),
      "utf-8",
    );

    expect(loadColoreContext(fixturePath).projection_rules[0]!.available).toBe(false);
  });

  it("uses the environment source while letting an explicit source take precedence", () => {
    process.env.GOALCHAINER_COLORE_PATH = fixturePath;
    expect(loadColoreContext().source_path).toBe(fixturePath);

    const explicitMissing = join(root, "explicitly-missing.metta");
    const context = loadColoreContext(explicitMissing);
    expect(context.source_path).toBe(explicitMissing);
    expect(context.source_available).toBe(false);
  });

  it("returns the source-compatible empty context for a missing file", () => {
    const missing = join(root, "missing.metta");
    expect(loadColoreContext(missing)).toEqual({
      source_path: missing,
      source_available: false,
      module_count: 0,
      axiom_count: 0,
      predicate_count: 0,
      gloss_count: 0,
      axiom_kinds: {},
      selected_axioms: [],
      projection_rules: [
        {
          id: "time-before-transitivity",
          source: "timepoints/lp_ordering/a1",
          available: false,
          kind: null,
          from: [
            "timepoint(x)",
            "timepoint(y)",
            "timepoint(z)",
            "before(x, y)",
            "before(y, z)",
          ],
          to: "before(x, z)",
          gloss: "",
        },
        {
          id: "relation-composition-grandchild",
          source: "kinship/definitions/hasGrandchild/HGC-1",
          available: false,
          kind: null,
          from: [
            "hasChild(x, y)",
            "hasChild(y, z)",
            "x != y",
            "y != z",
            "x != z",
          ],
          to: "hasGrandchild(x, z)",
          gloss: "",
        },
        {
          id: "relation-composition-sibling",
          source: "kinship/definitions/hasSibling/HS-1",
          available: false,
          kind: null,
          from: ["hasChild(z, x)", "hasChild(z, y)", "x != y"],
          to: "hasSibling(x, y)",
          gloss: "",
        },
      ],
    });
  });

  it("rejects non-file URLs because loading is synchronous", () => {
    expect(() => loadColoreContext(new URL("https://example.test/data-colore.metta"))).toThrowError(
      "COLORE source URL must use file: protocol: https:",
    );
  });
});
