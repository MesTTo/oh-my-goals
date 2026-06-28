# goalchainer-ts

GoalChainer is a goal-aware decision layer for an agent. Before the agent acts,
it weighs the individual's goal, the collective's goal, the deontic norms, and the
graded evidence, then ranks the actions. This is the TypeScript port, and its
reasoning runs on [`@metta-ts`](https://www.npmjs.com/package/@metta-ts/core), a
pure-TypeScript MeTTa (Hyperon) interpreter. No SWI-Prolog, no Python, no native
addon. It runs anywhere TypeScript runs.

The MeTTa-TS runtime it runs on: <https://github.com/MesTTo/Meta-TypeScript-Talk>

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
npm run cli -- demo           # the full decision: ranked actions, why, motivation, propositions, ontology
npm run cli -- validate       # the differential battery: same code, three requests, three verdicts
npm run cli -- snars          # the subjective-logic deduction
npm run cli -- motivation     # the individual-vs-collective consensus
npm run cli -- directive      # the decision as a claimable task
npm run cli -- codebase-demo  # generate a buggy TS repo, reason over it, patch it, rerun its tests
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

So each engine is reimplemented natively for `@metta-ts`, driven through the typed
`@metta-ts/edsl` API. There are no MeTTa source strings and no output parsing: the
engines build atoms with `rel`/`S`/`v`, add them to the space, fire rules with
`match`, and read typed results back. The reasoning runs on the interpreter, and so
does the arithmetic: the PLN truth formulas (deduction, count-space K=800 revision),
the subjective-logic mapping, the MetaMo consensus, the NAL expectation, and the
combined score are all built as engine arithmetic (`add`/`sub`/`mul`/`div`, with
`min` as a branch) and evaluated by `@metta-ts`, not computed in TypeScript. The
deontic dominance fold and the argmax selections stay in TypeScript because they are
control flow, not math. There is no fallback path: the score runs on the engine in
both modes, and the COLORE context reads its vendored data directly.

The result is checked against the original. `fixtures/py-*.json` are the real
outputs of the Python GoalChainer, and `tests/differential.test.ts` asserts this
port reproduces them value-for-value: the PLN strengths bit-for-bit
(`0.9339042316258351`), the SNARS opinion (`b=0.669421`, expectation `0.834711`),
the MetaMo consensus (`publish_redacted_summary 1.084`, `publish_raw_log -1.197`),
the ranked scores (`redacted 0.986774`, `raw -1.0`), and the leak check. The only
fields that differ are the runtime labels: this port honestly says `@metta-ts`
where the Python said `PeTTa`.

The COLORE ontology context, the HyperBase proposition rendering, the rich `demo`
output, and the `codebase-demo` repair workflow are all ported. The `codebase-demo`
is a pure-TypeScript reimplementation: it generates a TypeScript repo with the same
seeded leak and the same policy docs, runs its tests with Node, reasons over it, and
patches it, so the reasoning shape matches the Python while the generated code is
TypeScript. Still on the Python side only: the Ollama semantic-evidence path
(environment-gated; the keyword extractor is the default in both), and the
`lib_directive` plan lifecycle (status / next / claim), whose `gc_task_state`
mapping runs on `@metta-ts` while the plan execution is reimplemented.

## Develop

```bash
npm install
npm test          # differential oracle + per-engine unit tests
npm run build     # tsc -> dist
npx jscpd src     # 0 clones
```

## Links

- MeTTa-TS, the pure-TypeScript MeTTa runtime: <https://github.com/MesTTo/Meta-TypeScript-Talk>
- The original GoalChainer (on PeTTa, with the real OmegaClaw engines): <https://github.com/MesTTo/OmegaClaw-GoalChainer>

## License

MIT.
