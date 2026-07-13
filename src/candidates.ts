// Decompose one stored proposition into its searchable semantic candidates.
//
// A port of mettabase's semantic_candidates_for_edge (candidates.py:104-190),
// operating on this project's ShNode tree instead of a Python Hyperedge. One
// root proposition yields candidates for its original sentence, its whole typed
// edge, each nested subtree, each connector, and each role-bearing argument.
// Candidate ids are deterministic and derive from the proposition id, so a
// search hit always maps back to its canonical record and provenance. Running on
// the stored tree keeps the index rebuildable without the Python parser.

import type { ShNode } from "./hyperbase.js";
import type {
  CandidatePolarity,
  SemanticCandidate,
  SemanticUnitType,
} from "./vector_index.js";

const UNKNOWN_ROLE = "UnknownRole";

export interface DecompositionInput {
  readonly tree: ShNode;
  readonly edgeId: string;
  readonly spaceId: string;
  readonly sourceText?: string;
  readonly polarity?: CandidatePolarity;
  readonly epistemicKind?: string;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

/** First and second characters of an atom type, e.g. `Cc` -> `["C","c"]`. */
function typeParts(type: string): [string, string] {
  return [type.slice(0, 1) || "C", type.length > 1 ? type.slice(1) : "NoSubtype"];
}

/** The role letters after the dot in an atom role, e.g. `Pv.so` -> `so`. */
function atomRoles(role: string): string {
  const dot = role.indexOf(".");
  return dot >= 0 && dot + 1 < role.length ? role.slice(dot + 1) : "NoRoles";
}

/** Strip grouping punctuation from an argrole string to bare letters. */
function bareRoles(argroles: string): string {
  return argroles.replace(/[^a-zA-Z]/g, "");
}

/** The argument-role letters an edge assigns to its children. An atom connector
 * carries them after the dot of its own role (`does/Mm` has none); an edge
 * connector has none of its own, so the edge's inferred argroles are used. */
function roleLetters(connector: ShNode, argroles: string): string {
  if (connector.atom) {
    const dot = connector.role.indexOf(".");
    return dot >= 0 && dot + 1 < connector.role.length
      ? bareRoles(connector.role.slice(dot + 1))
      : "";
  }
  return bareRoles(argroles);
}

/** All leaf-atom labels in tree order, connector before arguments. */
export function labelsOf(node: ShNode): string[] {
  if (node.atom) return [node.label];
  const labels = labelsOf(node.connector);
  for (const child of node.children) labels.push(...labelsOf(child));
  return labels;
}

/** The `(main subtype roles)` tag of a node, from its connector when an edge. */
export function tagsOf(node: ShNode): [string, string, string] {
  if (node.atom) {
    const [main, subtype] = typeParts(node.type);
    return [main, subtype, atomRoles(node.role)];
  }
  const roles = roleLetters(node.connector, node.argroles) || "NoRoles";
  const [main, subtype] = typeParts(node.connector.atom ? node.connector.type : node.type);
  return [main, subtype, roles];
}

/** Render a node as typed MeTTa. Three forms: `sh-atom` for an atom, `sh` for an
 * edge with an atom connector, and `sh-conn` for an edge whose connector is
 * itself an edge that carries its own tag. */
export function typedMettaOf(node: ShNode): string {
  if (node.atom) {
    const [main, subtype] = typeParts(node.type);
    return `(sh-atom (tag ${main} ${subtype} ${atomRoles(node.role)} ()) ${quote(node.label)})`;
  }
  const letters = roleLetters(node.connector, node.argroles);
  const args = node.children
    .map((child, position) => {
      const role = position < letters.length ? letters[position]! : UNKNOWN_ROLE;
      return `(arg ${role} ${typedMettaOf(child)})`;
    })
    .join(" ");
  if (!node.connector.atom) {
    return `(sh-conn ${typedMettaOf(node.connector)} (args (${args})))`;
  }
  const [main, subtype] = typeParts(node.connector.type);
  return `(sh (tag ${main} ${subtype} ${letters || "NoRoles"} ()) ${quote(node.connector.label)} (args (${args})))`;
}

/** The untyped SH mirror of a node, atoms kept as `requires/Pv.so`. */
function rawMettaOf(node: ShNode): string {
  return node.atom ? node.atomStr : node.edgeStr;
}

/** Yield the edge, then recurse into its non-atom argument children. */
function* subedges(node: ShNode): Generator<ShNode> {
  yield node;
  if (node.atom) return;
  for (const child of node.children) {
    if (!child.atom) yield* subedges(child);
  }
}

/** Decompose a proposition tree into its ordered semantic candidates. */
export function semanticCandidatesForEdge(input: DecompositionInput): SemanticCandidate[] {
  const { tree, edgeId, spaceId, sourceText, polarity, epistemicKind } = input;
  const candidates: SemanticCandidate[] = [];

  const base = (
    atomId: string,
    unitType: SemanticUnitType,
    role: string | null,
    text: string,
    atom: string,
    node: ShNode,
  ): void => {
    candidates.push({
      atom,
      text,
      score: 0,
      spaceId,
      atomId,
      unitType,
      edgeId,
      role,
      ...(polarity !== undefined ? { polarity } : {}),
      ...(epistemicKind !== undefined ? { epistemicKind } : {}),
      payload: {
        raw_metta: rawMettaOf(node),
        typed_metta: typedMettaOf(node),
        labels: labelsOf(node),
        tags: tagsOf(node),
      },
    });
  };

  if (sourceText !== undefined && sourceText.trim() !== "") {
    candidates.push({
      atom: `(hb source ${edgeId} ${quote(sourceText)})`,
      text: sourceText,
      score: 0,
      spaceId,
      atomId: `${edgeId}:source`,
      unitType: "source",
      edgeId,
      role: null,
      ...(polarity !== undefined ? { polarity } : {}),
      ...(epistemicKind !== undefined ? { epistemicKind } : {}),
      payload: { candidate_kind: "source" },
    });
  }

  base(`${edgeId}:edge`, "edge", null, labelsOf(tree).join(" "), typedMettaOf(tree), tree);

  let subtreeIndex = 0;
  for (const subedge of subedges(tree)) {
    const index = subtreeIndex;
    subtreeIndex += 1;
    base(
      `${edgeId}:subtree:${index}`,
      "subtree",
      null,
      labelsOf(subedge).join(" "),
      typedMettaOf(subedge),
      subedge,
    );
    if (subedge.atom || subedge.children.length === 0) continue;

    const connector = subedge.connector;
    base(
      `${edgeId}:connector:${index}`,
      "connector",
      null,
      labelsOf(connector).join(" "),
      typedMettaOf(connector),
      connector,
    );

    const letters = roleLetters(subedge.connector, subedge.argroles);
    subedge.children.forEach((child, position) => {
      const role = position < letters.length ? letters[position]! : UNKNOWN_ROLE;
      const atomId =
        index === 0
          ? `${edgeId}:arg:${role}:${position}`
          : `${edgeId}:subtree:${index}:arg:${role}:${position}`;
      base(atomId, "argument", role, labelsOf(child).join(" "), typedMettaOf(child), child);
    });
  }

  return candidates;
}

/** The proposition ids referenced by a set of candidate atom ids. */
export function propositionIdsOf(atomIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const atomId of atomIds) {
    const marker = atomId.indexOf(":");
    ids.add(marker >= 0 ? atomId.slice(0, marker) : atomId);
  }
  return [...ids];
}
