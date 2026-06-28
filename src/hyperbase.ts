// Build the request's reasoning packet: the evidence and the @metta-ts action
// evidence (deontic verdict + PLN belief). A lean port of the part of
// goal_chainer/hyperbase.py the decision pipeline needs.

import { extractEvidence, evidenceToDict } from "./evidence.js";
import { reasonOverHyperbase, type HyperbaseReasonResult } from "./reasoner.js";

export interface HyperbasePacket {
  evidence: Record<string, unknown>;
  reasoner: HyperbaseReasonResult;
}

export function buildHyperbasePacket(request: string): HyperbasePacket {
  const evidence = extractEvidence(request);
  return {
    evidence: evidenceToDict(evidence),
    reasoner: reasonOverHyperbase(evidence),
  };
}
