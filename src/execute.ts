// Execute the recommended action on real incident data and verify the result.
// Ports goal_chainer/execute.py. The decision layer says what to do; this does
// it and checks it: real data in, a safe deliverable out, leak-checked.

export type Incident = {
  service: string;
  status: string;
  summary: string;
  next_update: string;
  raw_log: Record<string, string>;
};

// Fields that must never reach an external update, and diagnostics safe to keep.
const RESTRICTED_FIELDS = [
  "customer_email",
  "order_id",
  "request_payload",
  "access_token",
  "stack_trace",
  "raw_log",
];
const ALLOWED_DIAGNOSTICS = ["error_code", "failure_mode", "affected_surface"];

/** A realistic incident with sensitive values in the raw log. */
export function defaultIncident(): Incident {
  return {
    service: "checkout",
    status: "degraded",
    summary: "Checkout payment retries are timing out.",
    next_update: "15 minutes",
    raw_log: {
      customer_email: "ava@example.com",
      order_id: "ORD-19942",
      request_payload: "{card_token: tok_live_secret}",
      access_token: "tok_live_secret",
      stack_trace: "Traceback: internal checkout worker path",
      error_code: "PAYMENT_TIMEOUT",
    },
  };
}

/** Drop restricted values, keep allowed diagnostics. */
export function redact(rawLog: Record<string, string>): Record<string, string> {
  const diagnostics: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawLog)) {
    if (RESTRICTED_FIELDS.includes(key)) diagnostics[key] = "[redacted]";
    else if (ALLOWED_DIAGNOSTICS.includes(key)) diagnostics[key] = value;
  }
  return diagnostics;
}

function sensitiveValues(rawLog: Record<string, string>): string[] {
  return Object.entries(rawLog)
    .filter(([key, value]) => RESTRICTED_FIELDS.includes(key) && typeof value === "string")
    .map(([, value]) => value);
}

function leakCheck(artifact: unknown, rawLog: Record<string, string>): Record<string, unknown> {
  const dumped = JSON.stringify(artifact);
  const leaked = sensitiveValues(rawLog).filter((value) => value && dumped.includes(value));
  return { sent_external: true, leaked, safe: leaked.length === 0 };
}

/** Produce the deliverable for the chosen action, plus a leak check. */
export function executeAction(actionId: string, incident: Incident): Record<string, unknown> {
  const rawLog = incident.raw_log ?? {};
  if (actionId === "publish_redacted_summary") {
    const artifact = {
      service: incident.service,
      status: incident.status,
      summary: incident.summary,
      diagnostics: redact(rawLog),
      next_update: incident.next_update ?? "15 minutes",
    };
    return {
      action_id: actionId,
      channel: "external",
      artifact,
      leak_check: leakCheck(artifact, rawLog),
    };
  }
  if (actionId === "hold_external_update") {
    return {
      action_id: actionId,
      channel: "internal-only",
      artifact: {
        external: null,
        internal_note: "Holding external updates until the facts are verified.",
        internal_detail_available: Object.keys(rawLog).length > 0,
      },
      leak_check: { sent_external: false, leaked: [], safe: true },
    };
  }
  if (actionId === "publish_raw_log") {
    return {
      action_id: actionId,
      channel: "blocked",
      artifact: null,
      leak_check: { sent_external: false, leaked: [], safe: true },
      note: "Forbidden by the deontic gate; nothing is sent.",
    };
  }
  return { action_id: actionId, channel: "none", artifact: null };
}
