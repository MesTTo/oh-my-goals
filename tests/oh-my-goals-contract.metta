; Native Oh My Goals framework contract.

!(import! &self "../metta/oh-my-goals.metta")

!(assertEqual
   (gc-evidence-expectation 1.0 0.5)
   0.75)

!(assertEqual
   (gc-score-motivation permitted 0.0 0.0 1.0)
   0.54)

!(assertEqual
   (gc-score-motivation forbidden 1.0 1.0 1.0)
   -1.0)

!(assertEqual
   (gc-decide-motivation permitted 1.0 1.0 1.0 0)
   (NativeDecision 0.92 recommended))

!(assertEqual
   (gc-resolve-norm-tree action-a NormTreeEmpty)
   (NormResolution unregulated 0.0 ReasonEmpty))

!(assertEqual
   (gc-resolve-norm-tree
      action-a
      (NormBranch
         (NormLeaf (Norm action-a 0 forbid 5 "policy forbids action"))
         (NormBranch
            (NormLeaf (Norm action-a 1 oblige 5 "policy requires action"))
            (NormLeaf (Norm action-a 2 permit 1 "lower priority permission")))))
   (NormResolution
      conflict
      5
      (ReasonJoin
         (ReasonLeaf (NormReason forbid "policy forbids action"))
         (ReasonLeaf (NormReason oblige "policy requires action")))))

!(assertEqual
   (gc-goal-analysis
      ((Goal individual-goal individual 1.0 True)
       (Goal collective-goal collective 1.0 True))
      (individual-goal))
   (GoalAnalysis 0.5 1.0 0.0 (collective-goal)))

!(assertEqual
   (gc-rank-decisions
      ((DecisionRow preferred 0 0.9 recommended)
       (DecisionRow fallback 1 0.4 weak))
      0.000000001)
   (RankedDecisions
      ((DecisionRow preferred 0 0.9 recommended)
       (DecisionRow fallback 1 0.4 weak))
      (preferred)
      True))

!(assertEqual
   (let (RankedDecisions $ranked $tied $automatic)
      (gc-rank-decisions
         ((DecisionRow "first" 0 0.8 recommended)
          (DecisionRow "second" 1 0.8 recommended))
         0.000000001)
      (TieContract (gc-expression-length $tied) $automatic))
   (TieContract 2 False))

!(assertEqual
   (gc-motivation-consensus
      (1.0)
      (1.0)
      ((Candidate action-a (1.0) 0.0)))
   (MotivationResult
      (Some action-a)
      (Some action-a)
      (Some action-a)
      (Some action-a)
      ((ConsensusScore action-a 1.0))
      action-a))

!(assertEqual
   (gc-motivation-mask
      individual
      ((Goal goal-a individual 3.0 True)
       (Goal goal-b collective 7.0 False)))
   (1.0 0.0))

!(assertEqual
   (gc-motivation-candidate
      (MotivationAction
         action-a
         ((DefaultCorrelation True) (ExplicitCorrelation -0.25))
         (ExplicitRisk 0.2)))
   (Candidate action-a (1.0 -0.25) 0.2))

!(assertEqual
   (gc-pln-evaluate
      action-a
      ((PlnRule rule-a safe 1.0 1.0))
      ((PlnFact fact-a action-a safe 1.0 1.0)))
   (PlnResult
      (Belief 1.0 1.0 (RuleProof rule-a fact-a))
      ((Deduced rule-a fact-a 1.0 1.0))))

!(assertEqual
   (gc-snars-assess subject relation object source 2.0 0.0 0.5)
   (SnarsAssessment
      subject
      relation
      object
      source
      (Opinion 0.5 0.0 0.5 0.5)
      0.75))

!(assertEqual (gc-directive-task-state obligated) ready)
!(assertEqual (gc-directive-task-state conflict) blocked)
!(assertEqual (gc-directive-task-state unregulated) backlog)

; Memory lifecycle fixtures. Each proposition below is a distinct static scenario.
(MemoryProposition mp-active project observation)
(MemoryState mp-active active 1)
(MemoryAssertionState mp-active mp-active-s1 active)

(MemoryProposition mp-retracted project observation)
(MemoryState mp-retracted retracted 2)
(MemoryAssertionState mp-retracted mp-retracted-s1 active)

(MemoryProposition mp-unsupported project observation)
(MemoryState mp-unsupported active 1)
(MemoryAssertionState mp-unsupported mp-unsupported-s1 retracted)

(MemoryProposition mp-derived derived derived-conclusion)
(MemoryState mp-derived active 1)
(MemoryDerivation mp-derived rule-x (mp-active))

(MemoryProposition mp-derived-dead derived derived-conclusion)
(MemoryState mp-derived-dead active 1)
(MemoryDerivation mp-derived-dead rule-y (mp-retracted))

(MemoryProposition mp-cycle derived derived-conclusion)
(MemoryState mp-cycle active 1)
(MemoryDerivation mp-cycle rule-z (mp-cycle))

(MemoryProposition mp-old user goal)
(MemoryState mp-old superseded 2)
(MemoryAssertionState mp-old mp-old-s1 active)

!(assertEqual (gc-mem-active mp-active) True)
!(assertEqual (gc-mem-active mp-retracted) False)
!(assertEqual (gc-mem-active mp-unsupported) False)
!(assertEqual (gc-mem-active mp-derived) True)
!(assertEqual (gc-mem-active mp-derived-dead) False)
!(assertEqual (gc-mem-active mp-cycle) False)
!(assertEqual (gc-mem-active mp-old) False)
