// Grade each action's acceptability with a PLN contextual query on @metta-ts.
// Ports goal_chainer/evidence_chainer.py.
//
// The original ran PeTTaChainer (MeTTa on PeTTa). Here the same PLN statements
// (implication rules + per-action facts, each with an STV) run on @metta-ts: the
// program matches each fact to its rule by predicate and computes the modus-ponens
// deduction through the `pln-deduce-*` grounded kernels; when an action has more
// than one supporting fact, the deductions are merged by PLN revision. The
// deduction and revision arithmetic is byte-identical to PeTTaChainer's
// TotalMpFormula and count-space (K=800) revision.

import { runMettaGroups } from "./runtime.js";
import { registerTruthOps, revise } from "./truth.js";
import { ACTION_ORDER } from "./deontic.js";
import type { IncidentEvidence } from "./evidence.js";
import { privacyAtStake } from "./evidence.js";

export interface Belief {
  strength: number;
  confidence: number;
  proof: string;
}

// Shared PLN implication rules: predicate -> (ruleName, ruleStrength, ruleConfidence).
const RULES: Record<string, [string, number, number]> = {
  SupportsCollective: ["support_to_accept", 0.92, 0.95],
  Redacted: ["redaction_to_accept", 0.95, 0.97],
  ProtectsPrivacy: ["protect_to_accept", 0.85, 0.92],
  RisksPrivacy: ["risk_to_accept", 0.05, 0.9],
};

// Order in which merged rule-proofs are listed, to match PeTTaChainer's proof term.
const RULE_ORDER = ["redaction_to_accept", "support_to_accept", "protect_to_accept", "risk_to_accept"];

interface Fact {
  action: string;
  name: string;
  predicate: string;
  fs: number;
  fc: number;
}

function factsFor(evidence: IncidentEvidence): Fact[] {
  const facts: Fact[] = [];
  // publish_raw_log
  if (privacyAtStake(evidence)) {
    const count = evidence.sensitiveCategories.length;
    const freq = Math.min(0.98, 0.6 + 0.1 * count);
    facts.push({ action: "publish_raw_log", name: "raw_risk", predicate: "RisksPrivacy", fs: freq, fc: 0.95 });
  } else {
    facts.push({ action: "publish_raw_log", name: "raw_support", predicate: "SupportsCollective", fs: 0.95, fc: 0.95 });
  }
  // publish_redacted_summary
  const support = evidence.factsReady ? 0.95 : 0.55;
  facts.push({ action: "publish_redacted_summary", name: "red_support", predicate: "SupportsCollective", fs: support, fc: 0.95 });
  facts.push({ action: "publish_redacted_summary", name: "red_redacted", predicate: "Redacted", fs: 1.0, fc: 0.97 });
  // hold_external_update
  const protect = evidence.factsReady ? 0.85 : 0.95;
  facts.push({ action: "hold_external_update", name: "hold_protect", predicate: "ProtectsPrivacy", fs: protect, fc: 0.92 });
  return facts;
}

const DED_RE = /\(D (\S+) (\S+) (-?[0-9.eE+-]+) (-?[0-9.eE+-]+)\)/g;

// The PLN engine: match each fact to its rule by predicate, deduce through the
// grounded modus-ponens kernel, emit (D ruleName factName ds dc) per deduction.
const PLN_ENGINE = `
(= (ded $act)
   (match &self (fact $act $fname $pred $fs $fc)
     (match &self (rule $pred $rname $rs $rc)
       (D $rname $fname (pln-deduce-s $rs $rc $fs $fc) (pln-deduce-c $rs $rc $fs $fc)))))
`;

export function gradeBeliefs(evidence: IncidentEvidence): {
  beliefs: Record<string, Belief>;
  program: string;
  rawOutputs: string[];
} {
  const facts = factsFor(evidence);
  const ruleLines = Object.entries(RULES).map(
    ([pred, [name, rs, rc]]) => `(rule ${pred} ${name} ${rs} ${rc})`,
  );
  const factLines = facts.map((f) => `(fact ${f.action} ${f.name} ${f.predicate} ${f.fs} ${f.fc})`);
  const queries = ACTION_ORDER.map((a) => `!(collapse (ded ${a}))`).join("\n");
  const program = `${ruleLines.join("\n")}\n${factLines.join("\n")}\n${PLN_ENGINE}\n${queries}\n`;

  const groups = runMettaGroups(program, registerTruthOps);
  const beliefs: Record<string, Belief> = {};
  ACTION_ORDER.forEach((action, i) => {
    const text = (groups[i] ?? []).join(" ");
    const deductions = [...text.matchAll(DED_RE)].map((m) => ({
      rule: m[1]!,
      fact: m[2]!,
      s: Number(m[3]),
      c: Number(m[4]),
    }));
    if (deductions.length === 0) {
      throw new Error(`PLN returned no Acceptable belief for ${action}: ${text}`);
    }
    // Merge proof order follows PeTTaChainer's rule ordering.
    deductions.sort((x, y) => RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule));
    let tv: [number, number] = [deductions[0]!.s, deductions[0]!.c];
    for (let k = 1; k < deductions.length; k++) {
      tv = revise(tv, [deductions[k]!.s, deductions[k]!.c]);
    }
    const ruleProofs = deductions.map((d) => `(rule-proof ${d.rule} ${d.fact})`);
    const proofTerm = ruleProofs.length > 1 ? `(merge/revision ${ruleProofs.join(" ")})` : ruleProofs[0]!;
    const proof = `(: ${proofTerm} (Acceptable ${action}) (STV ${tv[0]} ${tv[1]}))`;
    beliefs[action] = { strength: tv[0], confidence: tv[1], proof };
  });
  return { beliefs, program, rawOutputs: groups.flat() };
}
