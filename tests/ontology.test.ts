import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadColoreContext,
  type ProjectionSpec,
} from "../src/ontology.js";

const FIXTURE = [
  "; focused COLORE fixture",
  '(colore module caller/relations "https://example.test/relations")',
  "(colore pred caller/relations relates 2)",
  "(colore axiom caller/relations r1 horn (forall ($x $y) (if (relates $x $y) (connected $x $y))))",
  '(colore gloss caller/relations r1 "related values are connected")',
  '(colore module unrelated "https://example.test/unrelated")',
  "(colore axiom unrelated u1 theorem (unrelated x))",
].join("\n");

const PROJECTION: ProjectionSpec = {
  id: "caller-relation-projection",
  module: "caller/relations",
  axiomId: "r1",
  expectedKind: "horn",
  expectedExpression: "(forall ($x $y) (if (relates $x $y) (connected $x $y)))",
  from: ["relates(x, y)"],
  to: "connected(x, y)",
};

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
    expect(context.selected_axioms).toEqual([]);
    expect(context.projection_rules).toEqual([]);
  });

  it("checks caller-supplied projections against the named source axiom", () => {
    const context = loadColoreContext(fixturePath, [PROJECTION]);

    expect(context.selected_axioms).toEqual([
      {
        source: "caller/relations/r1",
        module: "caller/relations",
        axiom_id: "r1",
        kind: "horn",
        expression: "(forall ($x $y) (if (relates $x $y) (connected $x $y)))",
        gloss: "related values are connected",
      },
    ]);
    expect(context.projection_rules).toEqual([
      {
        id: "caller-relation-projection",
        source: "caller/relations/r1",
        available: true,
        kind: "horn",
        from: ["relates(x, y)"],
        to: "connected(x, y)",
        gloss: "related values are connected",
      },
    ]);
  });

  it("accepts file URLs and reports the resolved filesystem path", () => {
    const context = loadColoreContext(pathToFileURL(fixturePath));
    expect(context.source_available).toBe(true);
    expect(context.source_path).toBe(fixturePath);
  });

  it("requires the caller's expected kind and expression to match exactly", () => {
    expect(loadColoreContext(fixturePath, [
      { ...PROJECTION, expectedKind: "definition" },
      { ...PROJECTION, id: "different-expression", expectedExpression: "(connected x y)" },
    ]).projection_rules.map((rule) => rule.available)).toEqual([false, false]);
  });

  it("uses the environment source while letting an explicit source take precedence", () => {
    expect(() => loadColoreContext()).toThrow(
      "COLORE source is required when GOALCHAINER_COLORE_PATH is not set",
    );
    process.env.GOALCHAINER_COLORE_PATH = fixturePath;
    expect(loadColoreContext().source_path).toBe(fixturePath);

    const explicitMissing = join(root, "explicitly-missing.metta");
    const context = loadColoreContext(explicitMissing);
    expect(context.source_path).toBe(explicitMissing);
    expect(context.source_available).toBe(false);
  });

  it("returns the source-compatible empty context for a missing file", () => {
    const missing = join(root, "missing.metta");
    expect(loadColoreContext(missing, [PROJECTION])).toEqual({
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
          id: "caller-relation-projection",
          source: "caller/relations/r1",
          available: false,
          kind: null,
          from: ["relates(x, y)"],
          to: "connected(x, y)",
          gloss: "",
        },
      ],
    });
  });

  it("rejects malformed or ambiguous projection declarations", () => {
    expect(() => loadColoreContext(fixturePath, [
      PROJECTION,
      { ...PROJECTION },
    ])).toThrow("duplicate projection spec ID");
    expect(() => loadColoreContext(fixturePath, [
      { ...PROJECTION, expectedExpression: "" },
    ])).toThrow("expectedExpression must be a nonblank string");
    expect(() => loadColoreContext(fixturePath, [
      { ...PROJECTION, extra: true } as any,
    ])).toThrow("contains unknown fields: extra");
    const sparse = [PROJECTION] as ProjectionSpec[];
    sparse.length = 2;
    expect(() => loadColoreContext(fixturePath, sparse)).toThrow(
      "projection specs must not contain holes",
    );
  });

  it("rejects non-file URLs because loading is synchronous", () => {
    expect(() => loadColoreContext(new URL("https://example.test/data-colore.metta"))).toThrowError(
      "COLORE source URL must use file: protocol: https:",
    );
    expect(() => loadColoreContext("" as any)).toThrow(
      "COLORE source path must be nonblank",
    );
    expect(() => loadColoreContext(4 as any)).toThrow(
      "COLORE source must be a filesystem path or file URL",
    );
  });

  it("rejects ontology text outside the documented adapter grammar", () => {
    writeFileSync(fixturePath, "(cl-text arbitrary-clif)", "utf-8");
    expect(() => loadColoreContext(fixturePath)).toThrow(
      "unsupported COLORE adapter record at line 1",
    );
  });
});
