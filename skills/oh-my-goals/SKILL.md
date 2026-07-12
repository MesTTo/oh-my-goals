---
name: oh-my-goals
description: Rank competing agent actions against caller-supplied goals, deontic norms, and graded evidence with Oh My Goals on MeTTa TS. Use when a coding task has multiple viable actions, required goals, individual versus collective interests, policy constraints, safety or privacy restrictions, or a consequential choice that needs a machine-readable decision receipt before execution.
---

# Oh My Goals

Use Oh My Goals as a decision gate before taking the selected action. Keep all facts and policy choices traceable to the user, repository, or tool output.

The installed CLI evaluates `metta/oh-my-goals.metta` on MeTTa TS 1.1.4. The module declares the rules for norms, goal coverage, omitted evidence expectations, scores, statuses, ranking, ties, motivation consensus, and automatic-execution eligibility. Large inputs use bounded grounded numeric and structural operations. Those operations mirror goal membership and partitioning, mask and correlation mapping, stable ranking and tie selection, and PLN applicability matching from the bounded MeTTa paths. TypeScript validates the input, encodes atoms, supplies those grounded operations, handles files and processes, decodes the receipt, and dispatches only caller-owned actions. The CLI does not ask Claude Code, Codex, or OpenCode to choose the result, and it does not read their authentication state.

## Evaluate a choice

1. Read [references/input-schema.md](references/input-schema.md).
2. List the concrete actions that are available now. Do not include unavailable or imaginary actions.
3. Translate stated goals into weighted individual or collective goals. Mark a goal required only when failure to satisfy it makes an action unacceptable.
4. Add only explicit norms. Do not invent permissions, obligations, or prohibitions. Use higher integer priority for the rule that should defeat a lower-priority conflict.
5. Record which goals each action actually satisfies.
6. Add evidence only when its source and numeric calibration are identifiable. Strength measures support for the proposition. Confidence measures reliability and coverage of that estimate. A passing command supports only the behavior it checks. Omit the evidence entry or use confidence `0` when no defensible calibration exists.
7. Write the JSON input to a project-local temporary file such as `ai-tmp/oh-my-goals-input.json`. Do not interpolate user text into a shell command.
8. Prefer `node_modules/.bin/oh-my-goals decide --input ai-tmp/oh-my-goals-input.json --pretty`. Before using any local or `PATH` command, check its `--help` output for the `decide`, `install-skill`, and `prolog-check` commands. If the local binary is absent, try `oh-my-goals` from `PATH` with the same identity check. Stop and report that `oh-my-goals` must be installed when neither command identifies this CLI.
9. Read the complete JSON receipt. Execute a selected action only when it is available, `recommended`, `automatic_execution_allowed` is true, `selection_tied` is false, and the action is already authorized by the user and the current task. A recommendation does not grant new permissions or remove an approval boundary. Treat a tie or any other status as a request for a user tie-break, more evidence, another action, or an explicit user decision.
10. Report the selected action, its status, missing required goals, applicable norm reasons, and the evidence source. Remove the temporary input after it is no longer useful.

## Guardrails

- Preserve the user's authority over goals and norms. Ask when a missing policy choice would change the result.
- Do not convert preferences into obligations or prohibitions.
- Do not claim that an action satisfies a goal without evidence from the task context.
- Keep action IDs stable between the input and any executor.
- Do not put credentials, tokens, private keys, or unredacted sensitive data in the input. The receipt retains the full scenario and evidence provenance. Use redacted references instead.
- Keep temporary inputs and receipts out of version control, and remove them when they are no longer needed.
- If automatic execution is not allowed, return the receipt and request a user tie-break, more evidence, another action, or an explicit user decision. Do not choose around the gate.
- Re-run Oh My Goals when goals, norms, evidence, or available actions change.
