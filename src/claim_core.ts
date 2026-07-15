// The logical core of a claim, extracted from its Semantic-Hypergraph parse.
//
// Two claims are about the same statement when they share a core: the same
// predicate acting on the same arguments, regardless of polarity. So "The method
// improves recall" and "The method does not improve recall" share the core
// (improv, s:method, o:recall) and differ only in polarity, which is what lets the
// symbolic layer read one as evidence for a statement and the other as evidence
// against it. This is encoding, the same kind of tree-to-key rendering as
// typedMettaOf; the corroboration and contradiction reasoning runs in MeTTa over
// the reflected cores.

import type { ShEdge, ShNode } from "./hyperbase.js";

export interface ClaimCore {
  /** A canonical, polarity-free key: predicate stem plus arguments by role. */
  readonly key: string;
  /** The predicate stem, e.g. "improv" for improves/improve. */
  readonly predicate: string;
  /** The subject head lemma when the relation has a subject role, else null. */
  readonly subject: string | null;
  /** The object head lemma when the relation has an object role, else null. */
  readonly object: string | null;
}

// Fold a surface verb to a stem that survives the third-person/base split the
// negation wrapper introduces (improves vs improve): drop a trailing plural or
// third-person "s". Kept deliberately light; deeper morphology is not worth the
// misfires on this controlled-English surface.
function stem(word: string): string {
  const lowered = word.toLowerCase();
  return lowered.length > 3 && lowered.endsWith("s") ? lowered.slice(0, -1) : lowered;
}

// The content head of an argument: descend an edge to its last child until an atom
// remains, so "the method" yields "method" and a bare atom yields itself.
function headLemma(node: ShNode): string {
  let current = node;
  while (!current.atom) {
    const children = current.children;
    if (children.length === 0) return current.connector.atom ? current.connector.root.toLowerCase() : "";
    current = children[children.length - 1]!;
  }
  return current.root.toLowerCase();
}

// The predicate under a relation connector, skipping the auxiliary and negation
// wrappers (Mm "does", Mn "not") to the innermost verb, so the core is the same
// whether or not the claim is negated.
function corePredicate(connector: ShNode): string {
  let current = connector;
  while (!current.atom) {
    if (current.children.length === 0) {
      current = current.connector;
    } else {
      current = current.children[0]!;
    }
  }
  return stem(current.root);
}

/** The logical core of a claim tree, or null when the tree is not a single
 * relation with arguments (nothing to group or contradict on). */
export function claimCore(tree: ShNode): ClaimCore | null {
  if (tree.atom || tree.mainType !== "R" || tree.children.length === 0) return null;
  const edge = tree as ShEdge;
  const predicate = corePredicate(edge.connector);
  if (predicate === "") return null;
  const roles = edge.argroles;
  const args = edge.children.map((child, index) => ({
    role: index < roles.length ? roles[index]! : "?",
    head: headLemma(child),
  }));
  const subject = args.find((arg) => arg.role === "s")?.head ?? null;
  const object = args.find((arg) => arg.role === "o")?.head ?? null;
  const sorted = [...args]
    .sort((a, b) => a.role.localeCompare(b.role) || a.head.localeCompare(b.head))
    .map((arg) => `${arg.role}:${arg.head}`)
    .join(",");
  return { key: `${predicate}(${sorted})`, predicate, subject, object };
}
