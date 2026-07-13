import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAll, standardTokenizer, type Atom } from "@metta-ts/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src");
const METTA = join(ROOT, "metta", "oh-my-goals.metta");

const EDSL_BOUNDARIES = new Map<string, ReadonlySet<string>>([
  ["src/metta.ts", new Set(["@metta-ts/edsl"])],
  ["src/prolog.ts", new Set(["@metta-ts/edsl/prolog"])],
  ["src/directive.ts", new Set(["@metta-ts/edsl", "@metta-ts/edsl/prolog"])],
]);

const REQUIRED_NATIVE_RELATIONS = [
  "gc-resolve-norm-tree",
  "gc-merge-norm-status",
  "gc-goal-analysis",
  "gc-goal-scores",
  "gc-evidence-expectation",
  "gc-default-risk",
  "gc-score-motivation",
  "gc-score-coverage",
  "gc-decision-status",
  "gc-evaluate-action",
  "gc-evaluate-action-analysis",
  "gc-evaluate-and-rank",
  "gc-rank-decisions",
  "gc-automatic-execution-allowed",
  "gc-selection-label",
  "gc-motivation-mask",
  "gc-motivation-candidate",
  "gc-motivation-availability",
  "gc-motivation-score-row",
  "gc-motivation-aggregate",
  "gc-motivation-consensus",
  "gc-pln-evaluate",
  "gc-snars-assess",
  "gc-snars-deduction",
  "gc-opinion-expectation",
  "gc-directive-task-state",
  "gc-directive-claimable",
  "gc-directive-claim-receipt",
  "gc-mem-active",
  "gc-mem-active-proposition",
  "gc-mem-active-in-scope",
  "gc-mem-active-of-kind",
] as const;

function sourceFiles(): readonly { path: string; source: ts.SourceFile }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => {
      const path = join(SRC, name);
      return {
        path: relative(ROOT, path),
        source: ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      };
    });
}

function expressionItems(atom: Atom): readonly Atom[] | undefined {
  return atom.kind === "expr" ? atom.items : undefined;
}

function symbolName(atom: Atom | undefined): string | undefined {
  return atom?.kind === "sym" ? atom.name : undefined;
}

function nativeDefinitions(): ReadonlySet<string> {
  const definitions = new Set<string>();
  const parsed = parseAll(readFileSync(METTA, "utf8"), standardTokenizer());
  expect(parsed.some(({ bang }) => bang)).toBe(false);

  for (const { atom } of parsed) {
    const top = expressionItems(atom);
    if (symbolName(top?.[0]) !== "=") continue;
    const left = expressionItems(top?.[1]!);
    const name = symbolName(left?.[0]);
    if (name?.startsWith("gc-")) definitions.add(name);
  }
  return definitions;
}

describe("native MeTTa architecture", () => {
  it("keeps the TypeScript eDSL surface inside encoding and Prolog adapters", () => {
    expect(existsSync(join(SRC, "engine.ts"))).toBe(false);

    const violations: string[] = [];
    for (const { path, source } of sourceFiles()) {
      const visit = (node: ts.Node): void => {
        let moduleName: string | undefined;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          moduleName = node.moduleSpecifier.text;
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]!)
        ) {
          moduleName = node.arguments[0]!.text;
        }

        if (moduleName?.startsWith("@metta-ts/edsl")) {
          if (!EDSL_BOUNDARIES.get(path)?.has(moduleName)) {
            violations.push(`${path}: ${moduleName}`);
          }
        }
        if (moduleName === "./engine.js" || moduleName === "../src/engine.js") {
          violations.push(`${path}: obsolete engine import`);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "rule"
        ) {
          violations.push(`${path}: TypeScript rule construction`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });

  it("defines every framework relation and every TypeScript relation call in MeTTa", () => {
    const definitions = nativeDefinitions();
    const groundedOperations = new Set<string>();
    const calledRelations = new Set<string>();

    for (const { source } of sourceFiles()) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const relationIndex = node.expression.text === "mettaCall"
            ? 0
            : node.expression.text === "mettaOne"
              ? 1
              : undefined;
          if (relationIndex !== undefined) {
            const argument = node.arguments[relationIndex];
            if (argument !== undefined && ts.isStringLiteral(argument) && argument.text.startsWith("gc-")) {
              calledRelations.add(argument.text);
            }
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "registerOperation" &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text.startsWith("gc-")
        ) {
          groundedOperations.add(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect([...REQUIRED_NATIVE_RELATIONS].filter((name) => !definitions.has(name))).toEqual([]);
    expect(
      [...calledRelations].filter(
        (name) => !definitions.has(name) && !groundedOperations.has(name),
      ),
    ).toEqual([]);
  });
});
