// Structured propositions and Semantic-Hypergraph facts for caller-supplied data.

import { assertDenseArray, assertKnownKeys, assertPlainRecord } from "./records.js";

const TOKEN_RE = /[^a-z0-9]+/g;

const STRUCTURED_ENGLISH_SYSTEM_PROMPT = `Rewrite the decision context into clear structured English propositions before evaluating actions.
Write one proposition per sentence.
Use one concrete subject, one predicate, and one object or complement.
Avoid pronouns and vague references.
Preserve domain terms from the source.
Keep observations, norms, goals, and recommendations in separate propositions.
Send the propositions to HyperBase first.
Use the resulting facts as evidence for the MeTTa-TS reasoner.`;

export interface StructuredPropositionInput {
  id: string;
  sentence: string;
  predicate: string;
  subject: string;
  object: string;
  source: string;
  edgePredicate?: string;
}

export interface StructuredProposition {
  id: string;
  sentence: string;
  predicate: string;
  subject: string;
  object: string;
  edge: string;
  tree: string;
  facts: string[];
  source: string;
}

export interface HyperbasePacket {
  contract: Record<string, unknown>;
  structured_english_prompt: string;
  structured_english: string[];
  propositions: StructuredProposition[];
  metta_program: string[];
}

const token = (label: string): string => {
  const readable =
    label.toLowerCase().replace(TOKEN_RE, "_").replace(/^_+|_+$/g, "") || "entity";
  let encoded = "";
  for (let index = 0; index < label.length; index += 1) {
    encoded += label.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `${readable}_u${encoded}`;
};
const quote = (text: string): string => JSON.stringify(text);
const edgeAtom = (label: string): string => `${token(label)}/Cc`;
const shAtom = (label: string): string => `(sh-atom (tag C c NoRoles ()) ${quote(label)})`;
const tree = (predicate: string, subject: string, object: string): string =>
  `(sh (tag P v so ()) ${quote(predicate)} (args ((arg s ${shAtom(subject)}) (arg o ${shAtom(object)}))))`;
const hbFact = (kind: string, ...parts: string[]): string => {
  const key = kind.replace(/-/g, " ").split(/\s+/).filter(Boolean).join(" ");
  return `(hb ${key} ${parts.join(" ")})`;
};

/** Build one HyperBase-ready structured proposition. */
export function makeProposition(input: StructuredPropositionInput): StructuredProposition {
  assertPlainRecord(input, "structured proposition");
  assertKnownKeys(input, "structured proposition", [
    "id",
    "sentence",
    "predicate",
    "subject",
    "object",
    "source",
    "edgePredicate",
  ]);
  const required = ["id", "sentence", "predicate", "subject", "object", "source"] as const;
  for (const key of required) {
    const value = input[key];
    if (typeof value !== "string") {
      throw new TypeError(`proposition ${key} must be a string`);
    }
    if (value.trim() === "") {
      throw new RangeError(`proposition ${key} must not be empty`);
    }
  }
  if (input.edgePredicate !== undefined && typeof input.edgePredicate !== "string") {
    throw new TypeError("proposition edgePredicate must be a string");
  }
  if (input.edgePredicate !== undefined && input.edgePredicate.trim() === "") {
    throw new RangeError("proposition edgePredicate must not be empty");
  }
  const edgePredicate = input.edgePredicate === undefined ? input.predicate : input.edgePredicate;
  const subjectEdge = edgeAtom(input.subject);
  const objectEdge = edgeAtom(input.object);
  const connector = `${token(edgePredicate)}/Pv.so`;
  const edge = `(${connector} ${subjectEdge} ${objectEdge})`;
  const treeValue = tree(edgePredicate, input.subject, input.object);
  const propositionId = quote(input.id);
  const facts = [
    hbFact("edge", propositionId, edge),
    hbFact("type", propositionId, "predicate"),
    hbFact("tree", propositionId, treeValue),
    hbFact("main-type", propositionId, "P"),
    hbFact("subtype", propositionId, "v"),
    hbFact("roles", propositionId, "so"),
    hbFact("namespace", propositionId, "()"),
    hbFact("sentence", propositionId, quote(input.sentence)),
    hbFact("source", propositionId, quote(input.source)),
    hbFact("connector", propositionId, connector),
    hbFact("arg-roles", propositionId, "so"),
    hbFact("connector-label", propositionId, quote(edgePredicate)),
    hbFact("connector-main-type", propositionId, "P"),
    hbFact("connector-subtype", propositionId, "v"),
    hbFact("connector-roles", propositionId, "so"),
    hbFact("connector-namespace", propositionId, "()"),
    hbFact("arg", propositionId, "s", subjectEdge),
    hbFact("arg-pos", propositionId, "0", "s", subjectEdge),
    hbFact("role-kind", propositionId, "0", "s", "subject"),
    hbFact("arg", propositionId, "o", objectEdge),
    hbFact("arg-pos", propositionId, "1", "o", objectEdge),
    hbFact("role-kind", propositionId, "1", "o", "object"),
  ];
  return {
    id: input.id,
    sentence: input.sentence,
    predicate: input.predicate,
    subject: input.subject,
    object: input.object,
    edge,
    tree: treeValue,
    facts,
    source: input.source,
  };
}

export function hyperbaseContract(): Record<string, unknown> {
  return {
    purpose: "structured propositions that HyperBase can translate into SH trees",
    rules: [
      "write one proposition per sentence",
      "use a concrete subject, predicate, and object or complement",
      "avoid pronouns and vague references",
      "preserve domain words from the source",
      "keep normative decisions separate from observed facts",
    ],
    primary_forms: [
      "(edge/Pv.so subject/Cc object/Cc)",
      '(sh (tag P v so ()) "predicate" (args ((arg s ...) (arg o ...))))',
      "(hb tree EDGE_ID SH_TREE)",
    ],
  };
}

export function structuredEnglishPrompt(): string {
  return STRUCTURED_ENGLISH_SYSTEM_PROMPT;
}

/** Assemble a HyperBase packet from explicit propositions. */
export function buildHyperbasePacket(
  inputs: readonly StructuredPropositionInput[],
): HyperbasePacket {
  assertDenseArray(inputs, "proposition inputs");
  const ids = new Set<string>();
  const propositions = inputs.map((input) => {
    const proposition = makeProposition(input);
    if (ids.has(proposition.id)) {
      throw new RangeError(`duplicate proposition ID: ${proposition.id}`);
    }
    ids.add(proposition.id);
    return proposition;
  });
  return {
    contract: hyperbaseContract(),
    structured_english_prompt: STRUCTURED_ENGLISH_SYSTEM_PROMPT,
    structured_english: propositions.map((proposition) => proposition.sentence),
    propositions,
    metta_program: propositions.flatMap((proposition) => proposition.facts),
  };
}
