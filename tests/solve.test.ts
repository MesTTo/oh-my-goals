import { describe, expect, it } from "vitest";

import type { ShAtom, ShEdge, ShNode } from "../src/hyperbase.js";
import { createMemorySpace, type MemoryScope, type MemorySpace, type MemorySourceInput } from "../src/memory.js";
import { actionReferences, MemoryEvidenceReasoner, solveFromMemory } from "../src/solve.js";
import { createCandidateAction } from "../src/models.js";

// SH-tree builders mirroring the real AlphaBeta output verified in
// ai-tmp/probe_solve_trees.ts. A candidate action names its identifier as a
// (+ action <id>) compound; a conclusion links to it by the identical compound.
function atom(root: string, type: string, role = type): ShAtom {
  return { atom: true, atomStr: `${root}/${type}`, root, label: root, mainType: type[0]!, type, role };
}
function edge(type: string, mainType: string, argroles: string, connector: ShNode, children: ShNode[]): ShEdge {
  return { atom: false, edgeStr: "()", mainType, type, argroles, connector, children };
}
function plus(type: string, id: string): ShEdge {
  return edge("C", "C", "am", atom("+", "B"), [atom(type, "Cc"), atom(id, "Cc")]);
}
function np1(det: string, noun: string): ShEdge {
  return edge("Cc", "C", "", atom(det, "Md"), [atom(noun, "Cc")]);
}
function relation(verb: string, subject: ShNode, object: ShNode): ShEdge {
  return edge("Rv", "R", "so", atom(verb, "Pv"), [subject, object]);
}

function actionTree(id: string): string {
  return JSON.stringify(relation("updates", plus("action", id), np1("the", "package")));
}
function conflictTree(id: string): string {
  return JSON.stringify(relation("conflicts", plus("action", id), np1("the", "constraint")));
}
function supportTree(id: string): string {
  return JSON.stringify(relation("satisfies", plus("action", id), np1("the", "goal")));
}

const SRC: MemorySourceInput[] = [{ type: "user", reference: "request" }];
const TOOL: MemorySourceInput[] = [{ type: "tool", reference: "npm test" }];

function space(): MemorySpace {
  return createMemorySpace({ repository: "demo" });
}

// Store an action, then a proof-only derived conclusion (support or conflict) that
// references it, resting on a fresh observation premise. Returns the premise id so
// a test can retract it and watch the conclusion, and the recommendation, restore.
function storeAction(memory: MemorySpace, id: string): void {
  memory.remember({
    content: `Action ${id} updates the database package directly.`,
    scope: "project",
    kind: "action",
    sources: SRC,
    shTree: actionTree(id),
    polarity: "affirmative",
  });
}
function deriveAbout(
  memory: MemorySpace,
  id: string,
  kind: "support" | "conflict",
  scope: MemoryScope = "project",
): string {
  const premise = memory.remember({
    content: `A ${kind} signal about ${id}.`,
    scope: "project",
    kind: "observation",
    sources: TOOL,
  });
  memory.derive({
    content: `Action ${id} ${kind === "conflict" ? "conflicts with the authentication constraint" : "satisfies the goal"}.`,
    rule: `${kind}-rule`,
    premises: [premise.id],
    scope,
    shTree: kind === "conflict" ? conflictTree(id) : supportTree(id),
    polarity: "affirmative",
  });
  return premise.id;
}

describe("actionReferences", () => {
  it("extracts the identifier from a (+ action <id>) compound", () => {
    const tree = relation("updates", plus("action", "upgrade_database"), np1("the", "package"));
    expect(actionReferences(tree)).toEqual(["upgrade_database"]);
  });
  it("finds the reference nested anywhere in the tree", () => {
    // "fails after action X": the compound sits under a temporal argument.
    const tree = relation("fails", np1("the", "test"), edge("Sx", "S", "", atom("after", "Tx"), [plus("action", "a_x")]));
    expect(actionReferences(tree)).toEqual(["a_x"]);
  });
  it("returns nothing when no action compound is present", () => {
    expect(actionReferences(relation("passes", np1("the", "test"), np1("the", "suite")))).toEqual([]);
  });
});

describe("projection from memory", () => {
  it("marks a goal required when its verb is an obligation, not a preference", () => {
    const memory = space();
    memory.remember({ content: "The user requires that the public API remains compatible.", scope: "project", kind: "goal", sources: SRC, shTree: JSON.stringify(relation("requires", np1("the", "user"), np1("the", "api"))), polarity: "affirmative" });
    memory.remember({ content: "The user prefers that the change is small.", scope: "project", kind: "goal", sources: SRC, shTree: JSON.stringify(relation("prefers", np1("the", "user"), np1("the", "change"))), polarity: "affirmative" });
    storeAction(memory, "a_x");
    const receipt = solveFromMemory(memory, { scope: "project" });
    const byStatement = new Map(receipt.scenario.goals.map((g) => [g.statement, g.required]));
    expect(byStatement.get("The user requires that the public API remains compatible.")).toBe(true);
    expect(byStatement.get("The user prefers that the change is small.")).toBe(false);
    memory.close();
  });

  it("synthesizes a baseline goal when memory holds none", () => {
    const memory = space();
    storeAction(memory, "a_x");
    const receipt = solveFromMemory(memory, { scope: "project" });
    expect(receipt.diagnostics.syntheticGoal).toBe(true);
    expect(receipt.scenario.goals).toHaveLength(1);
    expect(receipt.scenario.goals[0]!.id).toBe("goal:baseline");
    memory.close();
  });

  it("takes the action id from its identifier and records provenance", () => {
    const memory = space();
    storeAction(memory, "upgrade_database");
    const receipt = solveFromMemory(memory, { scope: "project" });
    expect(receipt.scenario.actions.map((a) => a.id)).toEqual(["upgrade_database"]);
    // The action id is the declared identifier; provenance points back to the
    // stored proposition (default id prefix "prop-"), not the identifier.
    expect(receipt.provenance.actions.upgrade_database).toMatch(/^prop-/);
    expect(receipt.diagnostics.actionsWithoutIdentifier).toEqual([]);
    memory.close();
  });

  it("falls back to the proposition id and flags an action with no identifier", () => {
    const memory = space();
    // An action-kind proposition that names no (+ action <id>) compound.
    const stored = memory.remember({ content: "The build ships nightly.", scope: "project", kind: "action", sources: SRC, shTree: JSON.stringify(relation("ships", np1("the", "build"), np1("the", "nightly"))), polarity: "affirmative" });
    const receipt = solveFromMemory(memory, { scope: "project" });
    expect(receipt.scenario.actions.map((a) => a.id)).toEqual([stored.id]);
    expect(receipt.diagnostics.actionsWithoutIdentifier).toEqual([stored.id]);
    memory.close();
  });

  it("links an action-targeting norm and reports an entity-constraining one as unlinked", () => {
    const memory = space();
    storeAction(memory, "a_deploy");
    // A norm that names the action: applied.
    const linked = memory.remember({ content: "The user forbids action a_deploy.", scope: "project", kind: "norm", sources: SRC, shTree: JSON.stringify(relation("forbids", np1("the", "user"), plus("action", "a_deploy"))), polarity: "affirmative" });
    // A norm that constrains an entity, not an action: reported, not applied.
    const unlinked = memory.remember({ content: "The user prohibits changes to the authentication module.", scope: "project", kind: "norm", sources: SRC, shTree: JSON.stringify(relation("prohibits", np1("the", "user"), np1("the", "module"))), polarity: "affirmative" });
    const receipt = solveFromMemory(memory, { scope: "project" });
    expect(receipt.scenario.norms.map((n) => n.targetAction)).toEqual(["a_deploy"]);
    expect(receipt.scenario.norms[0]!.mode).toBe("forbid");
    expect(receipt.provenance.norms[linked.id]).toBe(linked.id);
    expect(receipt.diagnostics.unlinkedNorms).toContain(unlinked.id);
    memory.close();
  });

  it("throws a clear error when no candidate action is active", () => {
    const memory = space();
    memory.remember({ content: "The user requires that the public API remains compatible.", scope: "project", kind: "goal", sources: SRC, shTree: JSON.stringify(relation("requires", np1("the", "user"), np1("the", "api"))), polarity: "affirmative" });
    expect(() => solveFromMemory(memory, { scope: "project" })).toThrow(/no active candidate actions/);
    memory.close();
  });

  it("rejects an unknown scope", () => {
    const memory = space();
    expect(() => solveFromMemory(memory, { scope: "nowhere" as never })).toThrow(/scope must be one of/);
    memory.close();
  });
});

describe("evidence projection", () => {
  it("forbids an action a conflict conclusion references, and supports one a support references", () => {
    const memory = space();
    storeAction(memory, "a_bad");
    storeAction(memory, "a_good");
    storeAction(memory, "a_plain");
    deriveAbout(memory, "a_bad", "conflict");
    deriveAbout(memory, "a_good", "support");
    const reasoner = new MemoryEvidenceReasoner(memory, "project");
    const bad = reasoner.project(createCandidateAction({ id: "a_bad", label: "l", description: "d", satisfies: [] }));
    const good = reasoner.project(createCandidateAction({ id: "a_good", label: "l", description: "d", satisfies: [] }));
    const plain = reasoner.project(createCandidateAction({ id: "a_plain", label: "l", description: "d", satisfies: [] }));
    expect(bad.deontic).toBe("forbidden");
    expect(good.deontic).toBe("unregulated");
    expect(good.strength).toBeGreaterThan(plain.strength);
    expect(plain.deontic).toBe("unregulated");
    memory.close();
  });
});

describe("exit criterion: evidence changes the recommendation, retraction restores it, a tie blocks", () => {
  it("resolves a tie to the surviving action on a derived conflict and restores it on retraction", () => {
    const memory = space();
    memory.remember({ content: "The user requires that the public API remains compatible.", scope: "project", kind: "goal", sources: SRC, shTree: JSON.stringify(relation("requires", np1("the", "user"), np1("the", "api"))), polarity: "affirmative" });
    storeAction(memory, "a_upgrade");
    storeAction(memory, "a_adapter");
    deriveAbout(memory, "a_upgrade", "support");
    deriveAbout(memory, "a_adapter", "support");

    // Both actions are supported and equal: a tie that blocks automatic execution.
    const initial = solveFromMemory(memory, { scope: "project" });
    expect(initial.recommended).toBeNull();
    expect(initial.tiedActionIds.slice().sort()).toEqual(["a_adapter", "a_upgrade"]);
    expect(initial.automaticExecutionAllowed).toBe(false);
    // Advice is still available even though automatic execution is not eligible.
    expect(initial.ranking.decisions).toHaveLength(2);

    // A tool result: the upgrade fails a test, and a conflict is derived from it.
    const premise = deriveAbout(memory, "a_upgrade", "conflict");
    const afterConflict = solveFromMemory(memory, { scope: "project" });
    expect(afterConflict.blockedActionIds).toEqual(["a_upgrade"]);
    expect(afterConflict.recommended).toBe("a_adapter");
    expect(afterConflict.automaticExecutionAllowed).toBe(true);
    expect(afterConflict.evidence.find((e) => e.actionId === "a_upgrade")!.deontic).toBe("forbidden");

    // Retract the observation the conflict rests on: the conclusion loses its only
    // proof and goes inactive, so the earlier tie is restored.
    memory.retract(premise);
    const afterRetract = solveFromMemory(memory, { scope: "project" });
    expect(afterRetract.blockedActionIds).toEqual([]);
    expect(afterRetract.recommended).toBeNull();
    expect(afterRetract.tiedActionIds.slice().sort()).toEqual(["a_adapter", "a_upgrade"]);
    expect(afterRetract.automaticExecutionAllowed).toBe(false);
    memory.close();
  });

  it("recommends a single supported action and reports its conflict provenance when blocked", () => {
    const memory = space();
    storeAction(memory, "a_solo");
    deriveAbout(memory, "a_solo", "support");
    const recommended = solveFromMemory(memory, { scope: "project" });
    expect(recommended.recommended).toBe("a_solo");
    expect(recommended.automaticExecutionAllowed).toBe(true);

    deriveAbout(memory, "a_solo", "conflict");
    const blocked = solveFromMemory(memory, { scope: "project" });
    expect(blocked.recommended).toBeNull();
    expect(blocked.blockedActionIds).toEqual(["a_solo"]);
    const trace = blocked.evidence.find((e) => e.actionId === "a_solo")!;
    expect(trace.conflicts).toHaveLength(1);
    expect(trace.supports).toHaveLength(1);
    memory.close();
  });

  it("reads a conclusion from the shared derived scope in a project solve, identically to one in project scope", () => {
    // The documented model keeps conclusions computed from the visible scopes in
    // the shared "derived" scope, and a solve reads them alongside its own scope.
    // A conflict stored in "derived" must block a project solve exactly as one
    // stored in "project" does, and retracting its premise must restore both.
    const derived = space();
    storeAction(derived, "a_solo");
    const premise = deriveAbout(derived, "a_solo", "conflict", "derived");
    const blockedFromDerived = solveFromMemory(derived, { scope: "project" });

    const project = space();
    storeAction(project, "a_solo");
    deriveAbout(project, "a_solo", "conflict", "project");
    const blockedFromProject = solveFromMemory(project, { scope: "project" });

    // A derived-scope conclusion blocks the project solve identically to a
    // project-scope one: same block set, same withheld recommendation.
    expect(blockedFromDerived.blockedActionIds).toEqual(["a_solo"]);
    expect(blockedFromDerived.blockedActionIds).toEqual(blockedFromProject.blockedActionIds);
    expect(blockedFromDerived.recommended).toBe(blockedFromProject.recommended);

    // Retracting the observation the derived-scope conclusion rests on invalidates
    // its proof across scopes, so the project solve restores the action.
    derived.retract(premise);
    const restored = solveFromMemory(derived, { scope: "project" });
    expect(restored.blockedActionIds).toEqual([]);
    derived.close();
    project.close();
  });
});
