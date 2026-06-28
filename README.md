# goalchainer-ts

GoalChainer is a goal-aware decision layer for an agent. Before the agent acts,
it weighs the individual's goal, the collective's goal, the deontic norms, and the
graded evidence, then ranks the actions. This is the TypeScript port, and its
reasoning runs on [`@metta-ts`](https://www.npmjs.com/package/@metta-ts/core), a
pure-TypeScript MeTTa (Hyperon) interpreter. No SWI-Prolog, no Python, no native
addon. It runs anywhere TypeScript runs.

## The scenario, run

Checkout is down. The on-call engineers want to paste the raw production logs into
the public incident channel so everyone can debug. The collective goal (fix it
fast, coordinate) says share everything. But those logs carry customer emails,
order IDs, and tokens, and the individual's goal (privacy) plus a norm say don't.

```bash
npm install
npm run cli -- solve
```

```
SOLVE: decided publish_redacted_summary (recommended), channel external
  blocked:     publish_raw_log  (lib_deontic: forbidden)
  individual -> publish_redacted_summary ; collective -> publish_raw_log
  consensus (MetaMo): publish_redacted_summary
  redacted: customer_email, order_id, request_payload, access_token, stack_trace
  kept: error_code=PAYMENT_TIMEOUT
  leak check: safe=true leaked=[]
```

The agent does not stop at a verdict. It runs the chosen action on the real
incident log (`ava@example.com`, `tok_live_secret`, `ORD-19942`, a stack trace),
produces the artifact it would actually send (every restricted value replaced with
`[redacted]`, the operational `PAYMENT_TIMEOUT` kept), and a leak check scans the
output for those exact values. None survive.

## How the reasoning works

Five steps, each derived from the request so the decision is a function of the
input, not a fixed answer:

1. **Evidence.** Read decision-relevant signals off the request (which sensitive
   categories are present, whether the data is declared public, whether the facts
   are ready).
2. **Deontic verdict.** A defeasible-deontic micro-engine derives each action's
   forbidden / obligated / permitted status. The request's evidence becomes a
   theory of `given` facts and defeasible `normally` rules; a rule fires its
   deontic head when its body is given; forbidden dominates obligated dominates
   permitted.
3. **Graded belief (PLN).** A PLN contextual query grades how strongly each action
   is believed acceptable. Per-action facts are matched to implication rules, each
   modus-ponens step is deduced, and multiple supporting facts are merged by
   revision, returning a strength and confidence with a proof term.
4. **Subjective-logic opinion (SNARS).** The key claim ("the raw log is forbidden")
   is deduced as a subjective-logic opinion `(b, d, u, a)` from evidence, with a
   provenance receipt.
5. **Individual vs collective (MetaMo).** Each goal owner is a motivation
   subsystem. The consensus picks the action both can accept, penalising
   disagreement: `consensus = (scoreI + scoreC)/2 - 0.25*|scoreI - scoreC|`.

The deontic verdict, the graded belief, and the consensus combine into a ranked,
deontic-gated score. The forbidden action is forced negative; the obligated action
that satisfies every required goal wins.

```bash
npm run cli -- validate     # the differential battery: same code, three requests, three verdicts
npm run cli -- snars        # the subjective-logic deduction
npm run cli -- motivation   # the individual-vs-collective consensus
npm run cli -- directive    # the decision as a claimable task
```

The library surface:

```ts
import { solveIncident, runValidation, skill } from "goalchainer-ts";

solveIncident("...the request...");   // decide + execute + leak check
runValidation();                      // the input-sensitivity battery
skill.decision("...the request...");  // the short OmegaClaw skill reply
```

## What runs on @metta-ts, precisely

This is a behaviour-faithful reimplementation, not a lift of the original engines.
The original GoalChainer ran four reasoning systems on PeTTa (MeTTa compiled to
SWI-Prolog): OmegaClaw-Core's `lib_deontic`, PeTTaChainer's PLN, a SNARS kernel,
and MetaMo. Three of those are bound to PeTTa's host: `lib_deontic`'s engine is a
set of SWI-Prolog kernels registered as MeTTa functions, and MetaMo imports a
Python helper. None of that runs on a pure-TypeScript runtime.

So each engine is reimplemented natively for `@metta-ts`. The symbolic reasoning
(matching facts to rules, firing defeasible rules, chaining deductions, folding the
deontic dominance, computing the consensus) runs as MeTTa programs on the
interpreter; the float arithmetic (the PLN truth formulas, the subjective-logic
mapping, the consensus and score) runs as small TypeScript grounded operations the
MeTTa programs call by name. That mirrors the original architecture, where the
PeTTa MeTTa called registered Prolog kernels for the same arithmetic, with the
kernels rewritten in TypeScript and run in-process.

The result is checked against the original. `fixtures/py-*.json` are the real
outputs of the Python GoalChainer, and `tests/differential.test.ts` asserts this
port reproduces them value-for-value: the PLN strengths bit-for-bit
(`0.9339042316258351`), the SNARS opinion (`b=0.669421`, expectation `0.834711`),
the MetaMo consensus (`publish_redacted_summary 1.084`, `publish_raw_log -1.197`),
the ranked scores (`redacted 0.986774`, `raw -1.0`), and the leak check. The only
fields that differ are the runtime labels: this port honestly says `@metta-ts`
where the Python said `PeTTa`.

Two things are not ported. The `lib_directive` plan lifecycle (status / next /
claim) is a separate Prolog kernel; the `gc_task_state` deontic-to-task mapping
runs on `@metta-ts`, but the plan execution is reimplemented deterministically. The
COLORE ontology and HyperBase proposition rendering used only by the richer `demo`
output are not included.

## Develop

```bash
npm install
npm test          # differential oracle + per-engine unit tests
npm run build     # tsc -> dist
npx jscpd src     # 0 clones
```

## License

MIT.
