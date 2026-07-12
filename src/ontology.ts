// Parse a COLORE source and check caller-declared projection rules.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  mettaOne,
  mettaString,
  sharedGoalChainerMetta,
} from "./metta.js";
import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";

const MODULE_RE = /^\(colore module (\S+) "([^"]+)"\)$/;
const AXIOM_RE = /^\(colore axiom (\S+) (\S+) (\S+) (.+)\)$/;
const GLOSS_RE = /^\(colore gloss (\S+) (\S+) "(.*)"\)$/;
const PRED_RE = /^\(colore pred (\S+) (\S+) (\d+)\)$/;

export type ColoreSource = string | URL;

export interface ColoreAxiom {
  source: string;
  module: string;
  axiom_id: string;
  kind: string;
  expression: string;
  gloss: string;
}

export interface ProjectionRule {
  id: string;
  source: string;
  available: boolean;
  kind: string | null;
  from: string[];
  to: string;
  gloss: string;
}

export interface ProjectionSpec {
  readonly id: string;
  readonly module: string;
  readonly axiomId: string;
  readonly expectedKind: string;
  readonly expectedExpression: string;
  readonly from: readonly string[];
  readonly to: string;
}

export interface OntologyContext {
  source_path: string;
  source_available: boolean;
  module_count: number;
  axiom_count: number;
  predicate_count: number;
  gloss_count: number;
  axiom_kinds: Record<string, number>;
  selected_axioms: ColoreAxiom[];
  projection_rules: ProjectionRule[];
}

function nonblank(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a nonblank string`);
  }
  return value;
}

function snapshotProjectionSpecs(specs: readonly ProjectionSpec[]): readonly ProjectionSpec[] {
  assertDenseArray(specs, "projection specs");
  const ids = new Set<string>();
  return Object.freeze(specs.map((spec, index) => {
    const path = `projection specs[${index}]`;
    assertPlainRecord(spec, path);
    assertKnownKeys(spec, path, [
      "id",
      "module",
      "axiomId",
      "expectedKind",
      "expectedExpression",
      "from",
      "to",
    ]);
    const id = nonblank(spec.id, `${path}.id`);
    if (ids.has(id)) throw new RangeError(`duplicate projection spec ID: ${id}`);
    ids.add(id);
    assertDenseArray(spec.from, `${path}.from`);
    const from = Object.freeze(spec.from.map((premise, premiseIndex) =>
      nonblank(premise, `${path}.from[${premiseIndex}]`),
    ));
    return Object.freeze({
      id,
      module: nonblank(spec.module, `${path}.module`),
      axiomId: nonblank(spec.axiomId, `${path}.axiomId`),
      expectedKind: nonblank(spec.expectedKind, `${path}.expectedKind`),
      expectedExpression: nonblank(
        spec.expectedExpression,
        `${path}.expectedExpression`,
      ),
      from,
      to: nonblank(spec.to, `${path}.to`),
    });
  }));
}

function projectionAvailable(axiom: ColoreAxiom, spec: ProjectionSpec): boolean {
  const value = mettaOne(
    sharedGoalChainerMetta(),
    "gc-projection-available",
    mettaString(axiom.kind),
    mettaString(axiom.expression),
    mettaString(spec.expectedKind),
    mettaString(spec.expectedExpression),
  );
  if (typeof value !== "boolean") {
    throw new Error("oh-my-goals.metta returned an invalid projection availability");
  }
  return value;
}

function projectionRules(
  axioms: ReadonlyMap<string, ColoreAxiom>,
  specs: readonly ProjectionSpec[],
): ProjectionRule[] {
  return specs.map((spec) => {
    const axiom = axioms.get(axiomKey(spec.module, spec.axiomId));
    return {
      id: spec.id,
      source: `${spec.module}/${spec.axiomId}`,
      available: axiom !== undefined && projectionAvailable(axiom, spec),
      kind: axiom ? axiom.kind : null,
      from: [...spec.from],
      to: spec.to,
      gloss: axiom ? axiom.gloss : "",
    };
  });
}

function selectedAxioms(
  axioms: ReadonlyMap<string, ColoreAxiom>,
  specs: readonly ProjectionSpec[],
): ColoreAxiom[] {
  const selected: ColoreAxiom[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const key = axiomKey(spec.module, spec.axiomId);
    const axiom = axioms.get(key);
    if (axiom !== undefined && !seen.has(key)) {
      seen.add(key);
      selected.push(axiom);
    }
  }
  return selected;
}

function axiomKey(module: string, id: string): string {
  return `${module}\0${id}`;
}

function resolveSource(source: ColoreSource | undefined): {
  readTarget: string | URL;
  sourcePath: string;
} {
  const selected = source ?? process.env.GOALCHAINER_COLORE_PATH;
  if (selected === undefined) {
    throw new TypeError(
      "COLORE source is required when GOALCHAINER_COLORE_PATH is not set",
    );
  }
  if (!(selected instanceof URL) && typeof selected !== "string") {
    throw new TypeError("COLORE source must be a filesystem path or file URL");
  }
  if (typeof selected === "string" && selected.trim() === "") {
    throw new TypeError("COLORE source path must be nonblank");
  }
  if (selected instanceof URL || selected.startsWith("file:")) {
    const url = selected instanceof URL ? selected : new URL(selected);
    if (url.protocol !== "file:") {
      throw new TypeError(`COLORE source URL must use file: protocol: ${url.protocol}`);
    }
    return { readTarget: url, sourcePath: fileURLToPath(url) };
  }
  return { readTarget: selected, sourcePath: selected };
}

/** Load ontology counts and caller-declared projections from a COLORE source. */
export function loadColoreContext(
  source?: ColoreSource,
  projectionSpecs: readonly ProjectionSpec[] = [],
): OntologyContext {
  const stableSpecs = snapshotProjectionSpecs(projectionSpecs);
  const { readTarget, sourcePath } = resolveSource(source);
  if (!existsSync(readTarget)) {
    const axioms = new Map<string, ColoreAxiom>();
    return {
      source_path: sourcePath,
      source_available: false,
      module_count: 0,
      axiom_count: 0,
      predicate_count: 0,
      gloss_count: 0,
      axiom_kinds: {},
      selected_axioms: [],
      projection_rules: projectionRules(axioms, stableSpecs),
    };
  }

  const text = readFileSync(readTarget, "utf-8");

  const modules: string[] = [];
  const predicates: number[] = [];
  const glossRows: number[] = [];
  const axiomRows: ColoreAxiom[] = [];
  const axioms = new Map<string, ColoreAxiom>();
  const glosses = new Map<string, string>();

  for (const [lineIndex, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(MODULE_RE))) {
      modules.push(m[1]!);
    } else if ((m = line.match(PRED_RE))) {
      predicates.push(1);
    } else if ((m = line.match(GLOSS_RE))) {
      glossRows.push(1);
      glosses.set(axiomKey(m[1]!, m[2]!), m[3]!);
    } else if ((m = line.match(AXIOM_RE))) {
      const axiom: ColoreAxiom = {
        source: `${m[1]}/${m[2]}`,
        module: m[1]!,
        axiom_id: m[2]!,
        kind: m[3]!,
        expression: m[4]!,
        gloss: "",
      };
      axiomRows.push(axiom);
      axioms.set(axiomKey(m[1]!, m[2]!), axiom);
    } else {
      throw new SyntaxError(
        `unsupported COLORE adapter record at line ${lineIndex + 1}: ${line}`,
      );
    }
  }

  // Attach glosses to axioms.
  for (const [key, axiom] of axioms) {
    axiom.gloss = glosses.get(key) ?? "";
  }

  const axiomKindCounts = new Map<string, number>();
  for (const axiom of axiomRows) {
    axiomKindCounts.set(axiom.kind, (axiomKindCounts.get(axiom.kind) ?? 0) + 1);
  }
  const axiomKinds = Object.fromEntries(axiomKindCounts);

  return {
    source_path: sourcePath,
    source_available: true,
    module_count: modules.length,
    axiom_count: axiomRows.length,
    predicate_count: predicates.length,
    gloss_count: glossRows.length,
    axiom_kinds: axiomKinds,
    selected_axioms: selectedAxioms(axioms, stableSpecs),
    projection_rules: projectionRules(axioms, stableSpecs),
  };
}
