import { describe, expect, it } from "vitest";

import { createCandidateAction } from "../src/models.js";
import {
  ContextualQueryEvidenceReasoner,
  PlnEvidenceReasoner,
  StaticEvidenceReasoner,
  type ContextualQueryRequest,
} from "../src/reasoner.js";

const action = () =>
  createCandidateAction({
    id: "candidate with spaces",
    label: "Candidate",
    description: "An action with contextual evidence",
    satisfies: [],
    evidenceQuery: "(Acceptable candidate)",
    evidenceAtoms: ["(Observed candidate)"],
  });

describe("generic evidence reasoners", () => {
  it("preserves static provenance, null projections, deontic status, and expectation", () => {
    const reasoner = new StaticEvidenceReasoner({
      "candidate with spaces": {
        strength: 0.8,
        confidence: 0.7,
        source: "caller observation",
        projection: null,
        deontic: "forbidden",
        expectation: 0.61,
      },
    });

    expect(reasoner.project(action())).toMatchObject({
      strength: 0.8,
      confidence: 0.7,
      source: "caller observation",
      projection: null,
      deontic: "forbidden",
      expectation: 0.61,
    });
  });

  it("derives an omitted static expectation after snapshotting input", () => {
    const evidence = {
      strength: 0.9,
      confidence: 0.9,
      source: "caller observation",
    };
    const reasoner = new StaticEvidenceReasoner({ "candidate with spaces": evidence });
    (evidence as any).strength = 0;

    expect(reasoner.project(action()).expectation).toBeCloseTo(0.86, 12);
  });

  it("requires static values to agree with a retained projection STV", () => {
    expect(() =>
      new StaticEvidenceReasoner({
        "candidate with spaces": {
          strength: 0.95,
          confidence: 0.95,
          source: "caller observation",
          projection: "(Answer (STV 0.05 0.05))",
        },
      }),
    ).toThrow(/evidence projection STV disagrees/);
  });

  it("passes action queries and atoms to an injected contextual adapter", () => {
    let observed: ContextualQueryRequest | undefined;
    const reasoner = new ContextualQueryEvidenceReasoner("context engine", (request) => {
      observed = request;
      return {
        projection: "(Answer (STV 0.8 0.75))",
        proofs: ["proof-one"],
        deontic: "obligated",
      };
    });

    const projected = reasoner.project(action());
    expect(observed).toEqual({
      actionId: "candidate with spaces",
      query: "(Acceptable candidate)",
      atoms: ["(Observed candidate)"],
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed!.atoms)).toBe(true);
    expect(projected).toMatchObject({
      strength: 0.8,
      confidence: 0.75,
      source: "context engine",
      projection: "(Answer (STV 0.8 0.75))",
      deontic: "obligated",
    });
    expect(projected.expectation).toBeCloseTo(0.725, 12);
  });

  it("does not infer an action truth value from free-text proofs", () => {
    const reasoner = new ContextualQueryEvidenceReasoner("context engine", () => ({
      projection: "no truth value",
      proofs: ["debug: unrelated item (STV 1 1)"],
    }));

    expect(() => reasoner.project(action())).toThrow("returned no truth value");
  });

  it("requires explicit contextual values to agree with the retained projection", () => {
    const matching = new ContextualQueryEvidenceReasoner("context engine", () => ({
      strength: 0.8,
      confidence: 0.7,
      projection: "(Answer (STV 0.8 0.7))",
    }));
    expect(matching.project(action())).toMatchObject({ strength: 0.8, confidence: 0.7 });

    const conflicting = new ContextualQueryEvidenceReasoner("context engine", () => ({
      strength: 0.8,
      confidence: 0.7,
      projection: "(Answer (STV 0.2 0.9))",
    }));
    expect(() => conflicting.project(action())).toThrow(/disagrees with its projection STV/);

    const invalidProjection = new ContextualQueryEvidenceReasoner("context engine", () => ({
      strength: 0.8,
      confidence: 0.7,
      projection: "(Answer (STV 1.2 0.7))",
    }));
    expect(() => invalidProjection.project(action())).toThrow(/projection strength/);
  });

  it("rejects missing queries, incomplete truth values, empty results, and blank sources", () => {
    const noQuery = createCandidateAction({
      id: "no-query",
      label: "No query",
      description: "No contextual query",
      satisfies: [],
    });
    expect(() => new ContextualQueryEvidenceReasoner("adapter", () => ({})).project(noQuery)).toThrow(
      "action has no contextual evidence query",
    );
    expect(() =>
      new ContextualQueryEvidenceReasoner("adapter", () => ({ strength: 0.5 })).project(action()),
    ).toThrow("both strength and confidence");
    expect(() =>
      new ContextualQueryEvidenceReasoner("adapter", () => ({})).project(action()),
    ).toThrow("returned no truth value");
    expect(() => new ContextualQueryEvidenceReasoner(" ", () => ({}))).toThrow(
      "source must not be empty",
    );
    expect(() => new ContextualQueryEvidenceReasoner("adapter", null as any)).toThrow(
      "adapter must be a function",
    );
    expect(() =>
      new ContextualQueryEvidenceReasoner("adapter", () => ({
        strength: 0.5,
        confidence: 0.5,
        source: " ",
      })).project(action()),
    ).toThrow("evidence source must not be blank");
    expect(() => new StaticEvidenceReasoner({ "candidate with spaces": null as any })).toThrow(
      "must be a plain object record",
    );
    expect(() =>
      new StaticEvidenceReasoner({
        "candidate with spaces": {
          strength: 0.5,
          confidence: 0.5,
          source: "test",
          proofs: "proof" as any,
        },
      }),
    ).toThrow("evidence proofs must be an array");
    expect(() =>
      new ContextualQueryEvidenceReasoner("adapter", () => ({ proofs: "proof" as any })).project(
        action(),
      ),
    ).toThrow("contextual query proofs must be an array");
    expect(() =>
      new StaticEvidenceReasoner({
        "candidate with spaces": {
          strength: 0.9,
          confidence: 0.9,
          source: "test",
          deonticStatus: "forbidden",
        } as any,
      }),
    ).toThrow("unknown fields: deonticStatus");
    expect(() =>
      new ContextualQueryEvidenceReasoner("adapter", () => ({
        strength: 0.9,
        confidence: 0.9,
        normStatus: "forbidden",
      } as any)).project(action()),
    ).toThrow("unknown fields: normStatus");
  });

  it("rejects accessor-backed actions before reasoners read their fields", () => {
    const reasoners = [
      new StaticEvidenceReasoner(),
      new PlnEvidenceReasoner({
        "candidate with spaces": {
          strength: 0.8,
          confidence: 0.7,
          proof: "caller proof",
        },
      }),
      new ContextualQueryEvidenceReasoner("adapter", () => ({
        strength: 0.8,
        confidence: 0.7,
      })),
    ];

    for (const reasoner of reasoners) {
      let getterCalls = 0;
      const accessorAction = { ...action() } as any;
      Object.defineProperty(accessorAction, "id", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "candidate with spaces";
        },
      });

      expect(() => reasoner.project(accessorAction)).toThrow(
        "candidate action.id must be an enumerable data property",
      );
      expect(getterCalls).toBe(0);
    }
  });
});
