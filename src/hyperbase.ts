// HyperBase-ready structured propositions for GoalChainer. Ports
// goal_chainer/hyperbase.py. Rewrites the request into structured-English
// propositions, renders each as Semantic-Hypergraph facts, and assembles the
// reasoning packet (propositions + ontology grounding + the @metta-ts reasoner).

import { extractEvidence, evidenceToDict, type IncidentEvidence } from "./evidence.js";
import { reasonOverHyperbase, type HyperbaseReasonResult } from "./reasoner.js";
import { loadColoreContext, type OntologyContext } from "./ontology.js";

const TOKEN_RE = /[^a-z0-9]+/g;

const STRUCTURED_ENGLISH_SYSTEM_PROMPT = `Rewrite the natural-language request into clear structured English propositions before tool use.
Write one proposition per sentence.
Use one concrete subject, one predicate, and one object or complement.
Avoid pronouns and vague references.
Preserve domain terms from the request.
Keep observations, norms, and recommendations in separate propositions.
Send the propositions to HyperBase first, then send the HyperBase projection to the native MeTTa/NAL reasoner.`;

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
  ontology_hint: string;
}

export interface HyperbasePacket {
  contract: Record<string, unknown>;
  structured_english_prompt: string;
  structured_english: string[];
  propositions: Record<string, unknown>[];
  metta_program: string[];
  ontology_grounding: Record<string, unknown>;
  evidence: Record<string, unknown>;
  reasoner: HyperbaseReasonResult;
}

const token = (label: string): string => label.toLowerCase().replace(TOKEN_RE, "_").replace(/^_+|_+$/g, "") || "entity";
const quote = (text: string): string => JSON.stringify(text);
const edgeAtom = (label: string): string => `${token(label)}/Cc`;
const shAtom = (label: string): string => `(sh-atom (tag C c NoRoles ()) ${quote(label)})`;
const tree = (predicate: string, subject: string, object: string): string =>
  `(sh (tag P v so ()) ${quote(predicate)} (args ((arg s ${shAtom(subject)}) (arg o ${shAtom(object)}))))`;
const hbFact = (kind: string, ...parts: string[]): string => {
  const key = kind.replace(/-/g, " ").split(/\s+/).filter(Boolean).join(" ");
  return `(hb ${key} ${parts.join(" ")})`;
};

function proposition(args: {
  propId: string;
  sentence: string;
  predicate: string;
  edgePredicate: string;
  subject: string;
  object: string;
  source: string;
  ontologyHint?: string;
}): StructuredProposition {
  const { propId, sentence, predicate, edgePredicate, subject, object, source } = args;
  const subjectEdge = edgeAtom(subject);
  const objectEdge = edgeAtom(object);
  const connector = `${token(edgePredicate)}/Pv.so`;
  const edge = `(${connector} ${subjectEdge} ${objectEdge})`;
  const treeStr = tree(edgePredicate, subject, object);
  const facts = [
    hbFact("edge", propId, edge),
    hbFact("type", propId, "predicate"),
    hbFact("tree", propId, treeStr),
    hbFact("main-type", propId, "P"),
    hbFact("subtype", propId, "v"),
    hbFact("roles", propId, "so"),
    hbFact("namespace", propId, "()"),
    hbFact("source", propId, quote(sentence)),
    hbFact("connector", propId, connector),
    hbFact("arg-roles", propId, "so"),
    hbFact("connector-label", propId, quote(edgePredicate)),
    hbFact("connector-main-type", propId, "P"),
    hbFact("connector-subtype", propId, "v"),
    hbFact("connector-roles", propId, "so"),
    hbFact("connector-namespace", propId, "()"),
    hbFact("arg", propId, "s", subjectEdge),
    hbFact("arg-pos", propId, "0", "s", subjectEdge),
    hbFact("role-kind", propId, "0", "s", "subject"),
    hbFact("arg", propId, "o", objectEdge),
    hbFact("arg-pos", propId, "1", "o", objectEdge),
    hbFact("role-kind", propId, "1", "o", "object"),
  ];
  return {
    id: propId,
    sentence,
    predicate,
    subject,
    object,
    edge,
    tree: treeStr,
    facts,
    source,
    ontology_hint: args.ontologyHint ?? "",
  };
}

/** Build one structured proposition, the surface goal_chainer/hyperbase.make_proposition exposes. */
export function makeProposition(args: {
  propId: string;
  sentence: string;
  predicate: string;
  subject: string;
  object: string;
  source: string;
  edgePredicate?: string;
  ontologyHint?: string;
}): StructuredProposition {
  return proposition({
    propId: args.propId,
    sentence: args.sentence,
    predicate: args.predicate,
    edgePredicate: args.edgePredicate ?? args.predicate,
    subject: args.subject,
    object: args.object,
    source: args.source,
    ontologyHint: args.ontologyHint ?? "",
  });
}

function restrictedItems(request: string): string[] {
  const items = [...extractEvidence(request).sensitiveCategories];
  return items.length > 0 ? items : ["raw evidence that may identify users or expose systems"];
}

export function incidentPropositions(request: string): StructuredProposition[] {
  const rows: StructuredProposition[] = [];
  let containedItems = restrictedItems(request).filter((item) => item !== "raw logs");
  if (containedItems.length === 0) containedItems = ["identifiable user data"];
  containedItems.forEach((item, i) => {
    rows.push(
      proposition({
        propId: `incident-pii-${i + 1}`,
        sentence: `Raw incident logs contain ${item}.`,
        predicate: "contain",
        edgePredicate: "contains",
        subject: "raw incident logs",
        object: item,
        source: "request",
      }),
    );
  });
  rows.push(
    proposition({ propId: "incident-risk-1", sentence: "Publishing raw incident logs exposes identifiable user data.", predicate: "expose", edgePredicate: "exposes", subject: "publishing raw incident logs", object: "identifiable user data", source: "goalchainer" }),
    proposition({ propId: "incident-control-1", sentence: "The redacted summary protects privacy.", predicate: "protect", edgePredicate: "protects", subject: "redacted summary", object: "privacy", source: "goalchainer" }),
    proposition({ propId: "incident-control-2", sentence: "The redacted summary supports responders.", predicate: "support", edgePredicate: "supports", subject: "redacted summary", object: "responders", source: "goalchainer" }),
    proposition({ propId: "incident-control-3", sentence: "Holding the external update protects privacy.", predicate: "protect", edgePredicate: "protects", subject: "holding external update", object: "privacy", source: "goalchainer" }),
    proposition({ propId: "incident-time-1", sentence: "Security review happens before verified customer update.", predicate: "before", edgePredicate: "before", subject: "security review", object: "verified customer update", source: "goalchainer", ontologyHint: "COLORE timepoints/lp_ordering licenses before transitivity" }),
  );
  return rows;
}

function hyperbaseContract(): Record<string, unknown> {
  return {
    purpose: "structured propositions that HyperBase can translate into SH trees",
    rules: [
      "write one proposition per sentence",
      "use concrete subject, predicate, and object or complement",
      "avoid pronouns and vague references",
      "preserve domain words from the request",
      "keep normative decisions separate from observed facts",
    ],
    primary_forms: [
      "(edge/Pv.so subject/Cc object/Cc)",
      '(sh (tag P v so ()) "predicate" (args ((arg s ...) (arg o ...))))',
      "(hb tree EDGE_ID SH_TREE)",
    ],
  };
}

function ontologyGrounding(ontology: OntologyContext | null): Record<string, unknown> {
  if (ontology === null) return { source_available: false, projection_rules: [] };
  return {
    source_available: ontology.source_available,
    source_path: ontology.source_path,
    module_count: ontology.module_count,
    axiom_count: ontology.axiom_count,
    projection_rules: ontology.projection_rules,
  };
}

export function buildHyperbasePacket(request: string, ontology?: OntologyContext | null): HyperbasePacket {
  const evidence: IncidentEvidence = extractEvidence(request);
  const propositions = incidentPropositions(request);
  return {
    contract: hyperbaseContract(),
    structured_english_prompt: STRUCTURED_ENGLISH_SYSTEM_PROMPT,
    structured_english: propositions.map((p) => p.sentence),
    propositions: propositions.map((p) => ({ ...p })),
    metta_program: propositions.flatMap((p) => p.facts),
    ontology_grounding: ontologyGrounding(ontology ?? null),
    evidence: evidenceToDict(evidence),
    reasoner: reasonOverHyperbase(evidence),
  };
}

export { loadColoreContext };
