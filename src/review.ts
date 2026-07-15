// review: structured evidence about a topic across the ingested literature.
//
// The pieces are already in place; review composes them. The semantic index
// retrieves the claims relevant to a topic (recall). Each claim's logical core
// groups it with the other claims that make the same statement, decided in MeTTa
// over the reflected ClaimCore facts (precision). For each statement, the works
// that assert it are positive evidence and the works that negate it are negative
// evidence; SNARS projects those counts to an opinion (the pi-PLN paraconsistent
// state where a statement can carry support and opposition at once). review then
// attaches each contributing work and warns when one is retracted, and returns
// the statements for the caller's model to write up. It asserts nothing the
// symbolic layer did not decide.

import type { MemoryScope } from "./memory.js";
import type { SemanticMemory } from "./semantic_memory.js";
import { assess } from "./snars.js";

export interface ReviewWorkRef {
  readonly claimId: string;
  readonly claim: string;
  readonly workId: string | null;
  readonly workTitle: string | null;
  readonly workStatus: string | null;
}

export interface ReviewOpinion {
  readonly belief: number;
  readonly disbelief: number;
  readonly uncertainty: number;
  readonly expectation: number;
}

export interface ReviewStatement {
  /** The statement's canonical core key. */
  readonly core: string;
  /** A representative claim sentence for the statement. */
  readonly statement: string;
  /** Asserted by two or more distinct works. */
  readonly corroborated: boolean;
  /** Asserted by some works and negated by others at once. */
  readonly contradicted: boolean;
  readonly affirming: readonly ReviewWorkRef[];
  readonly negating: readonly ReviewWorkRef[];
  /** The SNARS opinion projected from the affirming and negating work counts. */
  readonly opinion: ReviewOpinion;
  /** Warnings for a contributing work whose status is not active. A retracted or
   * withdrawn work's claims are already inactive and never reach here; what
   * surfaces is a corrected work or one under an expression of concern, whose
   * claim still counts but whose status the caller should weigh. */
  readonly statusWarnings: readonly string[];
}

export interface ReviewResult {
  readonly topic: string;
  readonly scope: MemoryScope;
  readonly statements: readonly ReviewStatement[];
}

export interface ReviewOptions {
  /** Claims to retrieve for the topic before grouping. Default 20. */
  readonly topK?: number;
}

/** Gather the topic's claims, group them into statements, and read agreement and
 * conflict across works, with provenance and retracted-source warnings. */
export async function reviewClaims(
  memory: SemanticMemory,
  topic: string,
  scope: MemoryScope,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const hits = await memory.search(topic, scope, { topK: options.topK ?? 20 });
  const visible = (claimScope: MemoryScope): boolean => claimScope === scope || claimScope === "user";

  // The distinct statements the topic surfaced, each with a representative sentence.
  const representatives = new Map<string, string>();
  for (const hit of hits) {
    const row = memory.claimCoreRow(hit.proposition.id);
    if (row !== null && !representatives.has(row.core)) {
      representatives.set(row.core, hit.proposition.content);
    }
  }

  const side = (core: string, polarity: string): ReviewWorkRef[] => {
    const refs: ReviewWorkRef[] = [];
    for (const claimId of memory.coreClaims(core, polarity)) {
      const proposition = memory.get(claimId);
      if (proposition === undefined || !visible(proposition.scope)) continue;
      const row = memory.claimCoreRow(claimId);
      const work = row !== null ? memory.getWork(row.unit) : undefined;
      refs.push({
        claimId,
        claim: proposition.content,
        workId: work?.id ?? null,
        workTitle: work?.title ?? null,
        workStatus: work?.status ?? null,
      });
    }
    return refs;
  };

  const statements: ReviewStatement[] = [];
  for (const [core, representative] of representatives) {
    const affirming = side(core, "affirmative");
    const negating = side(core, "negated");
    if (affirming.length === 0 && negating.length === 0) continue;
    // A work is one unit of evidence; a claim with no work counts as its own unit.
    const affirmingUnits = new Set(affirming.map((ref) => ref.workId ?? ref.claimId));
    const negatingUnits = new Set(negating.map((ref) => ref.workId ?? ref.claimId));
    const projection = assess("statement", "supported-by", "works", "review", {
      positive: affirmingUnits.size,
      negative: negatingUnits.size,
    });
    const statusWarnings = new Set<string>();
    for (const ref of [...affirming, ...negating]) {
      if (ref.workStatus !== null && ref.workStatus !== "active") {
        statusWarnings.add(`${ref.workTitle ?? ref.workId ?? ref.claimId} is ${ref.workStatus}`);
      }
    }
    statements.push({
      core,
      statement: representative,
      corroborated: affirmingUnits.size >= 2,
      contradicted: affirmingUnits.size >= 1 && negatingUnits.size >= 1,
      affirming,
      negating,
      opinion: {
        belief: projection.opinion.b,
        disbelief: projection.opinion.d,
        uncertainty: projection.opinion.u,
        expectation: projection.expectation,
      },
      statusWarnings: [...statusWarnings],
    });
  }

  // Contradictions first, then corroborations, then the rest: the most decision-
  // relevant evidence leads.
  statements.sort(
    (a, b) =>
      Number(b.contradicted) - Number(a.contradicted) || Number(b.corroborated) - Number(a.corroborated),
  );
  return { topic, scope, statements };
}
