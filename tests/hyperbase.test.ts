import { describe, expect, it } from "vitest";

import { atomToJs, parseSource } from "@metta-ts/edsl";
import type { ExpressionAtom } from "@metta-ts/hyperon";

import {
  buildHyperbasePacket,
  hyperbaseContract,
  makeProposition,
  structuredEnglishPrompt,
  type StructuredPropositionInput,
} from "../src/hyperbase.js";

const propositionInput = (
  overrides: Partial<StructuredPropositionInput> = {},
): StructuredPropositionInput => ({
  id: "proposition_one",
  sentence: "Entity A relates to Entity B.",
  predicate: "relate",
  subject: "Entity A",
  object: "Entity B",
  source: "caller",
  ...overrides,
});

describe("generic HyperBase propositions", () => {
  it("renders a structured proposition and its MeTTa facts", () => {
    const proposition = makeProposition(
      propositionInput({ edgePredicate: "is linked to" }),
    );

    expect(proposition.edge).toBe(
      "(is_linked_to_u006900730020006c0069006e006b0065006400200074006f/Pv.so entity_a_u0045006e007400690074007900200041/Cc entity_b_u0045006e007400690074007900200042/Cc)",
    );
    expect(proposition.tree).toBe(
      '(sh (tag P v so ()) "is linked to" (args ((arg s (sh-atom (tag C c NoRoles ()) "Entity A")) (arg o (sh-atom (tag C c NoRoles ()) "Entity B")))))',
    );
    expect(proposition.facts).toHaveLength(22);
    expect(proposition.facts[0]).toBe(
      '(hb edge "proposition_one" (is_linked_to_u006900730020006c0069006e006b0065006400200074006f/Pv.so entity_a_u0045006e007400690074007900200041/Cc entity_b_u0045006e007400690074007900200042/Cc))',
    );
    expect(proposition.facts).toContain('(hb sentence "proposition_one" "Entity A relates to Entity B.")');
    expect(proposition.facts).toContain('(hb source "proposition_one" "caller")');
    for (const fact of proposition.facts) expect(() => parseSource(fact)).not.toThrow();
  });

  it("rejects empty required proposition fields", () => {
    const fields: Array<keyof StructuredPropositionInput> = [
      "id",
      "sentence",
      "predicate",
      "subject",
      "object",
      "source",
      "edgePredicate",
    ];

    for (const field of fields) {
      expect(() => makeProposition(propositionInput({ [field]: "   " }))).toThrow(
        `proposition ${field} must not be empty`,
      );
    }
  });

  it("rejects non-string proposition fields before rendering atoms", () => {
    for (const field of ["id", "sentence", "predicate", "subject", "object", "source"] as const) {
      expect(() => makeProposition(propositionInput({ [field]: 123 as any }))).toThrow(
        `proposition ${field} must be a string`,
      );
    }
    expect(() => makeProposition(propositionInput({ edgePredicate: 123 as any }))).toThrow(
      "proposition edgePredicate must be a string",
    );
    expect(() =>
      makeProposition(propositionInput({ edgePredciate: "supports" } as any)),
    ).toThrow("structured proposition contains unknown fields: edgePredciate");
  });

  it("rejects duplicate proposition IDs in one packet", () => {
    expect(() =>
      buildHyperbasePacket([
        propositionInput(),
        propositionInput({ sentence: "A second statement uses the same ID." }),
      ]),
    ).toThrow("duplicate proposition ID: proposition_one");
  });

  it("rejects sparse proposition input arrays", () => {
    const inputs: StructuredPropositionInput[] = [];
    inputs.length = 1;
    expect(() => buildHyperbasePacket(inputs)).toThrow(
      "proposition inputs must not contain holes",
    );
  });

  it("keeps compact atoms distinct for colliding slugs and Unicode", () => {
    const pairs = [
      ["A-B", "A B"],
      ["α", "β"],
      ["\uD800", "\uD801"],
      ["\uD800", "\uFFFD"],
    ] as const;
    for (const [left, right] of pairs) {
      const proposition = makeProposition(
        propositionInput({ subject: left, object: right, predicate: "relates" }),
      );
      const [subjectAtom, objectAtom] = proposition.edge
        .slice(1, -1)
        .split(" ")
        .slice(1);
      expect(subjectAtom).not.toBe(objectAtom);
      for (const fact of proposition.facts) expect(() => parseSource(fact)).not.toThrow();
    }
  });

  it("assembles packet metadata", () => {
    const packet = buildHyperbasePacket([propositionInput()]);
    expect(packet.structured_english).toEqual(["Entity A relates to Entity B."]);
    expect(packet.metta_program).toHaveLength(22);
    expect(packet.contract).toEqual(hyperbaseContract());
    expect(packet.structured_english_prompt).toBe(structuredEnglishPrompt());
    expect(structuredEnglishPrompt()).toContain("Write one proposition per sentence.");
    expect(structuredEnglishPrompt()).toContain(
      "Use one concrete subject, one predicate, and one object or complement.",
    );
    expect(structuredEnglishPrompt()).toContain(
      "Keep observations, norms, goals, and recommendations in separate propositions.",
    );
    expect(structuredEnglishPrompt()).toContain("Send the propositions to HyperBase first.");
    expect(structuredEnglishPrompt()).toContain(
      "Use the resulting facts as evidence for the MeTTa-TS reasoner.",
    );
  });

  it("keeps 256 generated caller text variants parseable", () => {
    const fragments = [
      "plain text",
      'quoted "text"',
      "parenthesized (text)",
      "slash\\text",
      "line\nbreak",
      "café value",
      "符号 value",
      "punctuation !@#$%^&*[]{}",
    ];

    for (let index = 0; index < 256; index += 1) {
      const fragment = `${fragments[index % fragments.length]} ${index}`;
      const proposition = makeProposition(
        propositionInput({
          id: `proposition_${index}`,
          sentence: `${fragment}.`,
          predicate: `predicate ${fragment}`,
          edgePredicate: `edge ${fragment}`,
          subject: `subject ${fragment}`,
          object: `object ${fragment}`,
          source: `source ${fragment}`,
        }),
      );
      for (const fact of proposition.facts) expect(() => parseSource(fact)).not.toThrow();
    }
  });

  it("encodes caller proposition IDs as one literal atom", () => {
    const ids = [
      "two parts",
      "id) (extra",
      'quoted "id"',
      "line\nbreak",
      "$variable_like",
      "&space_like",
      "()",
      "α-id",
    ];

    for (const id of ids) {
      const proposition = makeProposition(propositionInput({ id }));
      const edgeFact = parseSource(proposition.facts[0]!) as ExpressionAtom;
      const children = edgeFact.children();
      expect(children).toHaveLength(4);
      expect(atomToJs(children[2]!)).toBe(id);
    }
  });
});
