# goalchainer-ts — port GoalChainer to TypeScript on @metta-ts

Goal: a working TypeScript GoalChainer whose reasoning runs in-process on
`@metta-ts` (pure-TS MeTTa), no swipl/PeTTa, no Python. Validated to reproduce
the Python reference outputs (fixtures/py-*.json) value-for-value.

## Why a reimplementation, not a lift
The original reasoning is NOT pure MeTTa: lib_deontic registers SWI-Prolog kernels
(grounding.pl, reason.pl, deontic.pl) as MeTTa functions; MetaMo imports a Python
helper; SNARS/PeTTaChainer run on PeTTa. None of that runs on a pure-TS runtime.
So the four engines are reimplemented natively as MeTTa programs on @metta-ts (plus
TS grounded ops for float math), proven behavior-equivalent by a differential oracle
against the captured Python outputs. Be precise about this in the README.

## Decomposition
- [x] Research: map Python surface (~4.5K LOC), reasoning substrate, @metta-ts API
- [x] Spike: confirm @metta-ts runs match-rule firing + grounded float ops
- [x] Capture Python ground-truth fixtures (validate/demo/snars/motivation/solve/directive)
- [x] Decode exact math: SNARS, MetaMo consensus, gc_score, expectation
- [x] PLN deduction+revision formula (deduce: rs*fs+0.2(1-fs); revise: count-space K=800)
- [x] Scaffold: package.json, tsconfig, vitest, npm i @metta-ts
- [x] runtime.ts: runMetta on @metta-ts (program -> result strings)
- [x] models.ts, evidence.ts, execute.ts, scenarios.ts, truth.ts
- [x] deontic.ts: defeasible-deontic micro-engine on @metta-ts  (3/3 cases)
- [x] pln.ts: PLN deduction+revision on @metta-ts  (strengths bit-for-bit)
- [x] snars.ts: subjective-logic NARS on @metta-ts  (b=0.669421, exp 0.834711)
- [x] motivation.ts: MetaMo consensus on @metta-ts  (1.084 / -1.197 / 0.002)
- [x] reasoner.ts, score.ts (gc_score on @metta-ts + offline), core.ts
- [x] pipeline.ts, validate.ts, explain.ts, directive.ts, hyperbase.ts (lean)
- [x] skill.ts, cli.ts, cli_support.ts, index.ts
- [x] tests: differential oracle (5) + per-engine unit (9) = 14 passing
- [x] README: precise account of the port
- [x] jscpd: 0 clones across 22 files; tsc build clean
- [ ] (stretch) hyperbase/ontology/semantic-evidence/codebase-demo enrichments
- [ ] (stretch) demo command full payload (ontology + propositions + counterfactuals)

## Status: core port DONE. All 6 commands reproduce the Python fixtures
value-for-value on @metta-ts (only runtime labels differ: "@metta-ts" not "PeTTa").

## Validation bar (differential oracle)
TS output must equal fixtures/py-*.json for: validate (raw -1.0 / redacted 0.9868),
snars (b 0.669421, exp 0.834711), motivation (consensus redacted 1.084 / raw -1.197),
solve (leak safe, redacted artifact), directive (ready/blocked).
