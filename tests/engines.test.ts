// Per-engine unit tests: each reasoning engine on @metta-ts, plus the truth-value
// kernels and the leak check, pinned to their known values.

import { describe, it, expect } from "vitest";
import { extractEvidence } from "../src/evidence.js";
import { deriveDeontic } from "../src/deontic.js";
import { gradeBeliefs } from "../src/pln.js";
import { deriveIncident } from "../src/snars.js";
import { deduce, revise } from "../src/truth.js";
import { defaultIncident, executeAction, redact } from "../src/execute.js";

const PII =
  "Checkout is down. Engineering wants to paste raw logs into the incident room. " +
  "Support says the logs may include customer emails, order IDs, and request payloads.";
const PUBLIC = "The outage is resolved. There is no sensitive data, it is safe to share publicly with engineering.";
const NOT_READY =
  "Checkout is down. Engineering wants to share raw logs with customer emails, but the root cause is unknown and the facts are not ready.";

describe("deontic engine on @metta-ts", () => {
  it("forbids the raw log under PII, obligates the redacted summary", () => {
    const s = deriveDeontic(extractEvidence(PII)).statusByAction;
    expect(s.publish_raw_log).toBe("forbidden");
    expect(s.publish_redacted_summary).toBe("obligated");
    expect(s.hold_external_update).toBe("permitted");
  });
  it("permits the raw log when the data is public", () => {
    expect(deriveDeontic(extractEvidence(PUBLIC)).statusByAction.publish_raw_log).toBe("permitted");
  });
  it("obligates holding when facts are not ready", () => {
    const s = deriveDeontic(extractEvidence(NOT_READY)).statusByAction;
    expect(s.publish_raw_log).toBe("forbidden");
    expect(s.hold_external_update).toBe("obligated");
  });
});

describe("PLN engine on @metta-ts", () => {
  it("reproduces PeTTaChainer strengths bit-for-bit", () => {
    const { beliefs } = gradeBeliefs(extractEvidence(PII));
    expect(beliefs.publish_redacted_summary!.strength).toBe(0.9339042316258351);
    expect(beliefs.publish_redacted_summary!.confidence).toBe(0.9771490750816104);
    expect(beliefs.hold_external_update!.strength).toBe(0.7525);
    expect(beliefs.publish_raw_log!.strength).toBe(0.053000000000000005);
  });
});

describe("truth-value kernels", () => {
  it("deduction matches the single-rule cases", () => {
    expect(deduce(0.85, 0.92, 0.85, 0.92)).toEqual([0.7525, 0.812]);
    const [s, c] = deduce(0.05, 0.9, 0.98, 0.95);
    expect(s).toBeCloseTo(0.053, 12);
    expect(c).toBeCloseTo(0.886, 12);
  });
  it("revision matches the count-space K=800 merge", () => {
    const [s, c] = revise([0.95, 0.97], [0.884, 0.9125]);
    expect(s).toBe(0.9339042316258351);
    expect(c).toBe(0.9771490750816104);
  });
});

describe("SNARS deduction on @metta-ts", () => {
  it("derives the forbidden opinion with the expected expectation", () => {
    const r = deriveIncident(PII) as Record<string, any>;
    expect(r.opinion.b).toBe(0.669421);
    expect(r.opinion.u).toBe(0.330579);
    expect(r.expectation).toBe(0.834711);
    expect(r.derived).toBe(true);
  });
});

describe("execution + leak check", () => {
  it("redacts every restricted field and keeps the diagnostic", () => {
    const d = redact(defaultIncident().raw_log);
    expect(d.customer_email).toBe("[redacted]");
    expect(d.access_token).toBe("[redacted]");
    expect(d.error_code).toBe("PAYMENT_TIMEOUT");
  });
  it("the leak check confirms no sensitive value survives", () => {
    const out = executeAction("publish_redacted_summary", defaultIncident());
    const leak = out.leak_check as { safe: boolean; leaked: string[] };
    expect(leak.safe).toBe(true);
    expect(leak.leaked).toEqual([]);
  });
});
