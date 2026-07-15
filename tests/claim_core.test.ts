import { describe, expect, it } from "vitest";

import { claimCore } from "../src/claim_core.js";
import type { ShAtom, ShEdge, ShNode } from "../src/hyperbase.js";

function atom(root: string, type: string): ShAtom {
  return { atom: true, atomStr: `${root}/${type}`, root, label: root, mainType: type[0]!, type, role: type };
}
function edge(type: string, mainType: string, argroles: string, connector: ShNode, children: ShNode[]): ShEdge {
  return { atom: false, edgeStr: "()", mainType, type, argroles, connector, children };
}
// "the <noun>" as a determiner edge, head is the noun.
function np(noun: string): ShEdge {
  return edge("Cc", "C", "", atom("the", "Md"), [atom(noun, "Cc")]);
}
// A subject-object relation with an atom predicate.
function relation(verb: string, subject: ShNode, object: ShNode): ShEdge {
  return edge("Rv", "R", "so", atom(verb, "Pv"), [subject, object]);
}
// The negated predicate wrapper the parser builds: (does (not <verb>)).
function negatedConnector(verb: string): ShEdge {
  return edge("Pv", "P", "so", atom("does", "Mm"), [
    edge("Pv", "P", "so", atom("not", "Mn"), [atom(verb, "Pv")]),
  ]);
}

describe("claimCore", () => {
  it("extracts a predicate stem and arguments by role", () => {
    const core = claimCore(relation("improves", np("method"), atom("recall", "Cc")));
    expect(core).not.toBeNull();
    expect(core!.key).toBe("improve(o:recall,s:method)");
    expect(core!.predicate).toBe("improve");
    expect(core!.subject).toBe("method");
    expect(core!.object).toBe("recall");
  });

  it("gives the negated form the same core as the affirmative one", () => {
    const affirmative = claimCore(relation("improves", np("method"), atom("recall", "Cc")));
    const negated = claimCore(edge("Rv", "R", "so", negatedConnector("improve"), [np("method"), atom("recall", "Cc")]));
    expect(negated!.key).toBe(affirmative!.key);
  });

  it("keeps antonym predicates and different subjects as distinct cores", () => {
    const improves = claimCore(relation("improves", np("method"), atom("recall", "Cc")))!.key;
    const reduces = claimCore(relation("reduces", np("method"), atom("recall", "Cc")))!.key;
    const otherSubject = claimCore(relation("improves", np("approach"), atom("recall", "Cc")))!.key;
    expect(reduces).not.toBe(improves);
    expect(otherSubject).not.toBe(improves);
  });

  it("returns null when the tree is not a relation with arguments", () => {
    expect(claimCore(atom("recall", "Cc"))).toBeNull();
    expect(claimCore(edge("Cc", "C", "", atom("the", "Md"), [atom("method", "Cc")]))).toBeNull();
  });
});
