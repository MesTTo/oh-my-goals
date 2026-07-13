; Oh My Goals reasoning relations for MeTTa TS.
; TypeScript loads this file and supplies validated facts and query arguments.

; Structural inputs are Atom-typed so the evaluator does not call tuple data.
(: gc-normalize-values (-> Atom %Undefined%))
(: gc-normalize-values-fast (-> Atom %Undefined%))
(: gc-affine-normalize-atom (-> Atom Number Number Number Bool Atom))
(: gc-vector-sum-atom (-> Atom Number))
(: gc-vector-dot-atom (-> Atom Atom Number))
(: gc-goal-mask-atom (-> Atom Atom Atom))
(: gc-goal-fold-atom (-> Atom Atom Atom))
(: gc-correlation-values-atom (-> Atom Atom))
(: gc-pack-candidate-atom (-> Atom Atom Number Atom))
(: gc-motivation-consensus-bridge-atom (-> Atom Atom Atom Atom))
(: gc-motivation-score-tree-atom (-> Atom Atom))
(: gc-flatten-motivation-consensus-tree-atom (-> Atom Atom))
(: gc-round-number-atom (-> Number Number Number))
(: gc-rank-decision-rows-atom (-> Atom Number Atom))
(: gc-pln-match-tree-atom (-> Atom Atom Atom Atom))
(: gc-goal-analysis (-> Atom Atom %Undefined%))
(: gc-goal-input-valid (-> Atom Bool))
(: gc-simple-identity (-> Atom Bool))
(: gc-identities-simple (-> Atom Bool))
(: gc-goal-identities-simple (-> Atom Bool))
(: gc-decision-identities-simple (-> Atom Bool))
(: gc-pln-identities-simple (-> Atom Atom Atom Bool))
(: gc-goal-scores (-> Number Number Number Number Number Number %Undefined%))
(: gc-evaluate-action (-> Atom Atom Atom Atom Atom %Undefined%))
(: gc-evaluate-action-analysis (-> Atom Atom Atom Atom Atom %Undefined%))
(: gc-evaluate-and-rank (-> Atom Number %Undefined%))
(: gc-rank-decisions (-> Atom Number %Undefined%))
(: gc-automatic-execution-allowed (-> Atom Number Bool))
(: gc-decision-rows-valid (-> Atom Atom Atom Bool))
(: gc-motivation-consensus (-> Atom Atom Atom %Undefined%))
(: gc-motivation-consensus-expressions (-> Atom Atom Atom %Undefined%))
(: gc-motivation-availability (-> Atom Atom %Undefined%))
(: gc-motivation-score-row (-> Atom Atom Atom Bool Bool %Undefined%))
(: gc-motivation-pull-tree-atom (-> Atom Atom Atom Atom))
(: gc-motivation-fold-pull-tree (-> Bool Bool Atom %Undefined%))
(: gc-motivation-consensus-canonical (-> Atom Atom Atom %Undefined%))
(: gc-motivation-aggregate (-> Atom Bool Bool %Undefined%))
(: gc-motivation-mask (-> Atom Atom %Undefined%))
(: gc-motivation-candidate (-> Atom %Undefined%))
(: gc-pln-evaluate (-> Atom Atom Atom %Undefined%))
(: gc-pln-rules-valid (-> Atom Bool))
(: gc-pln-facts-valid (-> Atom Bool))
(: gc-pln-deductions-for-rule (-> Atom Atom Atom %Undefined%))
(: gc-pln-deductions (-> Atom Atom Atom %Undefined%))
(: gc-pln-belief (-> Atom %Undefined%))
(: gc-pln-revision-step (-> Atom Atom %Undefined%))
(: gc-sum (-> Atom Number))
(: gc-sum-native (-> Atom Number))
(: gc-dot (-> Atom Atom Number))
(: gc-dot-native (-> Atom Atom Number))
(: gc-dot-native-loop (-> Atom Atom Number Number Number))
(: gc-candidate-score (-> Atom Atom Bool Number))
(: gc-best-candidate (-> Atom Atom Bool %Undefined%))
(: gc-best-candidate-step (-> Atom Bool Atom Atom %Undefined%))
(: gc-best-candidate-loop (-> Atom Bool Atom Number Atom %Undefined%))
(: gc-consensus-score (-> Atom Atom Atom Bool Bool Number))
(: gc-consensus-from-scores (-> Number Number Bool Bool Number))
(: gc-consensus-scores (-> Atom Atom Atom Bool Bool %Undefined%))
(: gc-best-consensus (-> Atom %Undefined%))
(: gc-best-consensus-step (-> Atom Atom %Undefined%))
(: gc-candidate-id (-> Atom Atom))
(: gc-consensus-id (-> Atom Atom))
(: gc-consensus-value (-> Atom Number))
(: gc-opinion-expectation (-> Atom Number))
(: gc-finite-number (-> Atom Bool))
(: gc-compensated-add (-> Atom Number %Undefined%))
(: gc-compensated-value (-> Atom Number))
(: gc-motivation-best-set-merge (-> Atom Atom %Undefined%))
(: gc-motivation-fold-merge (-> Atom Atom %Undefined%))
(: gc-motivation-fold-score-tree (-> Atom %Undefined%))
(: gc-motivation-state-from-score-row (-> Atom %Undefined%))
(: gc-motivation-finalize (-> Bool Bool Atom %Undefined%))
(: gc-number-vector-valid (-> Atom Bool))
(: gc-correlation-numbers-valid (-> Atom Bool))
(: gc-motivation-candidates-valid (-> Atom Number Bool))
(: gc-motivation-inputs-simple-atom (-> Atom Atom Atom Bool))
(: gc-identity-valid (-> Atom Bool))
(: Deduced (-> Atom Atom Number Number Atom))

; Shared numeric and expression helpers.

(= (gc-min $left $right)
   (if (<= $left $right) $left $right))

(= (gc-max $left $right)
   (if (>= $left $right) $left $right))

(= (gc-abs $value)
   (if (>= $value 0.0) $value (- 0.0 $value)))

(= (gc-clamp01 $value)
   (if (<= $value 0.0)
       0.0
       (if (>= $value 1.0) 1.0 $value)))

(= (gc-finite-number $value)
   (if (== (get-type $value) Number)
       (and (not (isnan-math $value)) (not (isinf-math $value)))
       False))

; Python 3.12+ uses Neumaier compensated summation for float inputs.
(= (gc-compensated-add ($high $low) $value)
   (let* (
      ($total (+ $high $value))
      ($correction
         (if (>= (gc-abs $high) (gc-abs $value))
             (+ (- $high $total) $value)
             (+ (- $value $total) $high)))
      ($next-low (+ $low $correction)))
      (noeval ($total $next-low))))

(= (gc-compensated-value ($high $low))
   (if (and (not (== $low 0.0)) (gc-finite-number $low))
       (+ $high $low)
       $high))

(= (gc-expression-length $items)
   (size-atom (noeval $items)))

(= (gc-expression-contains $needle $items)
   (is-member $needle $items))

(= (gc-sum-native $values)
   (let ($high $low)
      (foldl-atom
         $values
         (0.0 0.0)
         $sum
         $value
         (gc-compensated-add $sum $value))
      (if (and (not (== $low 0.0)) (gc-finite-number $low))
          (+ $high $low)
          $high)))

(= (gc-sum $values)
   (if (<= (size-atom (noeval $values)) 8)
       (gc-sum-native $values)
       (gc-vector-sum-atom $values)))

(= (gc-dot-native-loop $left $right $high $low)
   (if (== (noeval $left) ())
       (if (and (not (== $low 0.0)) (gc-finite-number $low))
           (+ $high $low)
           $high)
       (let* (
          (($left-head $left-tail) (decons-atom $left))
          (($right-head $right-tail) (decons-atom $right))
          ($value (* $left-head $right-head))
          ($total (+ $high $value))
          ($correction
             (if (>= (gc-abs $high) (gc-abs $value))
                 (+ (- $high $total) $value)
                 (+ (- $value $total) $high)))
          ($next-low (+ $low $correction)))
          (gc-dot-native-loop $left-tail $right-tail $total $next-low))))

(= (gc-dot-native $left $right)
   (gc-dot-native-loop $left $right 0.0 0.0))

(= (gc-dot $left $right)
   (if (<= (size-atom (noeval $left)) 8)
       (gc-dot-native $left $right)
       (gc-vector-dot-atom $left $right)))

(= (gc-normalize-one $value $low $high)
   (if (== $low $high)
       1.0
       (let* (
          ($span (- $high $low)))
          (if (<= $span 1.7976931348623157e308)
              (gc-clamp01 (/ (- $value $low) $span))
              (let* (
                 ($scale (gc-max (gc-abs $low) (gc-abs $high)))
                 ($scaled-low (/ $low $scale))
                 ($scaled-span (- (/ $high $scale) $scaled-low)))
                 (gc-clamp01 (/ (- (/ $value $scale) $scaled-low) $scaled-span)))))))

(= (gc-normalize-values $values)
   (if (== (noeval $values) ())
       ()
       (let* (
          ($low (min-atom (noeval $values)))
          ($high (max-atom (noeval $values)))
          ($collapsed
             (collapse
                (let $value (superpose (noeval $values))
                     (gc-normalize-one $value $low $high)))))
          (gc-collapse-tail $collapsed))))

(= (gc-collapse-tail $collapsed)
   (let ($marker $items) (decons-atom $collapsed) $items))

; The MeTTa TS host provides gc-affine-normalize-atom as a bulk numeric
; primitive. MeTTa still derives the bounds, overflow-safe scale, and branch.
(= (gc-normalize-values-fast $values)
   (if (== (noeval $values) ())
       ()
       (let* (
          ($low (min-atom (noeval $values)))
          ($high (max-atom (noeval $values)))
          ($span (- $high $low)))
          (if (== $low $high)
              (gc-affine-normalize-atom $values 0.0 1.0 1.0 True)
              (if (<= $span 1.7976931348623157e308)
                  (gc-affine-normalize-atom $values $low $span 1.0 False)
                  (let* (
                     ($scale (gc-max (gc-abs $low) (gc-abs $high)))
                     ($scaled-low (/ $low $scale))
                     ($scaled-span (- (/ $high $scale) $scaled-low)))
                     (gc-affine-normalize-atom
                        $values
                        $scaled-low
                        $scaled-span
                        $scale
                        False)))))))

; Deontic policy resolution.

(= (gc-add-mode $mode (ModeFlags $forbid $permit $oblige))
   (if (== $mode forbid)
       (ModeFlags True $permit $oblige)
       (if (== $mode permit)
           (ModeFlags $forbid True $oblige)
           (ModeFlags $forbid $permit True))))

(= (gc-status-from-flags (ModeFlags $forbid $permit $oblige))
   (if (and $forbid (or $permit $oblige))
       conflict
       (if $forbid
           forbidden
           (if $oblige obligated permitted))))

; Balanced norm trees keep policy selection native without linear recursion.
(: gc-tree-resolution-leaf (-> Atom Atom %Undefined%))
(= (gc-tree-resolution-leaf
      $action
      (Norm $norm-action $index $mode $priority $reason))
   (if (noreduce-eq $action $norm-action)
       (let $flags (gc-add-mode $mode (ModeFlags False False False))
            (noeval
              (TreeResolutionState
                $priority
                $flags
                (ReasonLeaf (NormReason $mode $reason)))))
       (noeval (TreeResolutionNoPriority))))

(: gc-tree-resolution-merge (-> Atom Atom %Undefined%))
(= (gc-tree-resolution-merge
      (TreeResolutionNoPriority)
      (TreeResolutionNoPriority))
   (noeval (TreeResolutionNoPriority)))

(= (gc-tree-resolution-merge
      (TreeResolutionNoPriority)
      (TreeResolutionState $priority $flags $reasons))
   (noeval (TreeResolutionState $priority $flags $reasons)))

(= (gc-tree-resolution-merge
      (TreeResolutionState $priority $flags $reasons)
      (TreeResolutionNoPriority))
   (noeval (TreeResolutionState $priority $flags $reasons)))

(= (gc-tree-resolution-merge
      (TreeResolutionState
        $left-priority
        (ModeFlags $left-forbid $left-permit $left-oblige)
        $left-reasons)
      (TreeResolutionState
        $right-priority
        (ModeFlags $right-forbid $right-permit $right-oblige)
        $right-reasons))
   (if (> $left-priority $right-priority)
       (noeval
         (TreeResolutionState
           $left-priority
           (ModeFlags $left-forbid $left-permit $left-oblige)
           $left-reasons))
       (if (> $right-priority $left-priority)
           (noeval
             (TreeResolutionState
               $right-priority
               (ModeFlags $right-forbid $right-permit $right-oblige)
               $right-reasons))
           (let* (
              ($forbid (or $left-forbid $right-forbid))
              ($permit (or $left-permit $right-permit))
              ($oblige (or $left-oblige $right-oblige)))
             (noeval
               (TreeResolutionState
                 $left-priority
                 (ModeFlags $forbid $permit $oblige)
                 (ReasonJoin $left-reasons $right-reasons)))))))

(: gc-tree-resolution-state (-> Atom Atom %Undefined%))
(= (gc-tree-resolution-state $action NormTreeEmpty)
   (noeval (TreeResolutionNoPriority)))

(= (gc-tree-resolution-state $action (NormLeaf $norm))
   (gc-tree-resolution-leaf $action $norm))

(= (gc-tree-resolution-state $action (NormBranch $left $right))
   (let* (
      ($left-state (gc-tree-resolution-state $action $left))
      ($right-state (gc-tree-resolution-state $action $right)))
     (gc-tree-resolution-merge $left-state $right-state)))

(: gc-finalize-tree-resolution (-> Atom %Undefined%))
(= (gc-finalize-tree-resolution (TreeResolutionNoPriority))
   (noeval (NormResolution unregulated 0.0 ReasonEmpty)))

(= (gc-finalize-tree-resolution
      (TreeResolutionState $priority $flags $reasons))
   (let $status (gc-status-from-flags $flags)
        (noeval (NormResolution $status $priority $reasons))))

(: gc-resolve-norm-tree (-> Atom Atom %Undefined%))
(= (gc-resolve-norm-tree $action $tree)
   (let $state (gc-tree-resolution-state $action $tree)
        (gc-finalize-tree-resolution $state)))

(= (gc-merge-norm-status $declared $projected)
   (if (== $declared unregulated)
       $projected
       (if (or (== $projected unregulated) (== $projected $declared))
           $declared
           (if (or (== $declared conflict) (== $projected conflict))
               conflict
               (if (or (== $declared forbidden) (== $projected forbidden))
                   conflict
                   (if (or (== $declared obligated) (== $projected obligated))
                       obligated
                       permitted))))))

; Goal coverage and required-goal checks.

; Expression identities are valid, but the current MeTTa TS evaluator can
; exhaust its stack while reducing them in a linear native scan. Route those
; inputs through the balanced structural primitives instead.
(= (gc-simple-identity $atom)
   (and (is-ground $atom) (not (is-expr $atom))))

(= (gc-identities-simple $items)
   (if (== $items ())
       True
       (let* (
          (($head $tail) (decons-atom $items)))
          (and
             (gc-simple-identity $head)
             (gc-identities-simple $tail)))))

(= (gc-goal-identities-simple $goals)
   (if (== $goals ())
       True
       (let* (
          (($head $tail) (decons-atom $goals))
          ((Goal $id $kind $weight $required) $head))
          (and
             (gc-simple-identity $id)
             (gc-goal-identities-simple $tail)))))

(= (gc-decision-identities-simple $rows)
   (if (== $rows ())
       True
       (let* (
          (($head $tail) (decons-atom $rows))
          ((DecisionRow $action $order $score $status) $head))
          (and
             (gc-simple-identity $action)
             (gc-decision-identities-simple $tail)))))

(= (gc-pln-rule-identities-simple $rules)
   (if (== $rules ())
       True
       (let* (
          (($head $tail) (decons-atom $rules))
          ((PlnRule $id $predicate $strength $confidence) $head))
          (and
             (and
                (gc-simple-identity $id)
                (gc-simple-identity $predicate))
             (gc-pln-rule-identities-simple $tail)))))

(= (gc-pln-fact-identities-simple $facts)
   (if (== $facts ())
       True
       (let* (
          (($head $tail) (decons-atom $facts))
          ((PlnFact $id $action $predicate $strength $confidence) $head))
          (and
             (and
                (and
                   (gc-simple-identity $id)
                   (gc-simple-identity $action))
                (gc-simple-identity $predicate))
             (gc-pln-fact-identities-simple $tail)))))

(= (gc-pln-identities-simple $action $rules $facts)
   (and
      (and
         (gc-simple-identity $action)
         (gc-pln-rule-identities-simple $rules))
      (gc-pln-fact-identities-simple $facts)))

(= (gc-goal-input-valid $goals)
   (if (== $goals ())
       True
       (let* (
          (($head $tail) (decons-atom $goals))
          ((Goal $id $kind $weight $required) $head))
          (and
             (and
                (or (== $kind individual) (== $kind collective))
                (and (gc-finite-number $weight) (>= $weight 0.0)))
             (and
                (or (== $required True) (== $required False))
                (gc-goal-input-valid $tail))))))

(= (gc-goal-sums-loop
      $goals
      $satisfied
      $total
      $covered
      $individual-total
      $individual-covered
      $collective-total
      $collective-covered)
   (if (== $goals ())
       (let* (
          ($total-value (gc-compensated-value $total))
          ($covered-value (gc-compensated-value $covered))
          ($individual-total-value (gc-compensated-value $individual-total))
          ($individual-covered-value (gc-compensated-value $individual-covered))
          ($collective-total-value (gc-compensated-value $collective-total))
          ($collective-covered-value (gc-compensated-value $collective-covered)))
          (noeval (GoalSums
             $total-value
             $covered-value
             $individual-total-value
             $individual-covered-value
             $collective-total-value
             $collective-covered-value)))
       (let* (
          (($head $tail) (decons-atom $goals))
          ((Goal $id $kind $weight $required) $head)
          ($is-satisfied (gc-expression-contains $id $satisfied))
          ($next-total (gc-compensated-add $total $weight))
          ($next-covered
             (if $is-satisfied (gc-compensated-add $covered $weight) $covered))
          ($next-individual-total
             (if (== $kind individual)
                 (gc-compensated-add $individual-total $weight)
                 $individual-total))
          ($next-individual-covered
             (if (and (== $kind individual) $is-satisfied)
                 (gc-compensated-add $individual-covered $weight)
                 $individual-covered))
          ($next-collective-total
             (if (== $kind collective)
                 (gc-compensated-add $collective-total $weight)
                 $collective-total))
          ($next-collective-covered
             (if (and (== $kind collective) $is-satisfied)
                 (gc-compensated-add $collective-covered $weight)
                 $collective-covered)))
          (gc-goal-sums-loop
             $tail
             $satisfied
             $next-total
             $next-covered
             $next-individual-total
             $next-individual-covered
             $next-collective-total
             $next-collective-covered))))

(= (gc-goal-sums $goals $satisfied)
   (let $initial (noeval (0.0 0.0))
      (gc-goal-sums-loop
         $goals
         $satisfied
         $initial
         $initial
         $initial
         $initial
         $initial
         $initial)))

(= (gc-required-missing $goals $satisfied)
   (if (== $goals ())
       ()
       (let* (
          (($head $tail) (decons-atom $goals))
          ((Goal $id $kind $weight $required) $head)
          ($tail-missing (gc-required-missing $tail $satisfied)))
          (if (and $required (not (gc-expression-contains $id $satisfied)))
              (cons-atom $id $tail-missing)
              $tail-missing))))

(= (gc-finalize-goal-analysis
      (GoalSums
         $total
         $covered
         $individual-total
         $individual-covered
         $collective-total
         $collective-covered)
      $missing)
   (let* (
      ((GoalScores $all-score $individual-score $collective-score)
         (gc-goal-scores
            $total
            $covered
            $individual-total
            $individual-covered
            $collective-total
            $collective-covered)))
      (noeval (GoalAnalysis $all-score $individual-score $collective-score $missing))))

(= (gc-goal-scores
      $total
      $covered
      $individual-total
      $individual-covered
      $collective-total
      $collective-covered)
   (let* (
      ($all-score (if (== $total 0.0) 0.0 (/ $covered $total)))
      ($individual-score
         (if (== $individual-total 0.0)
             0.0
             (/ $individual-covered $individual-total)))
      ($collective-score
         (if (== $collective-total 0.0)
             0.0
             (/ $collective-covered $collective-total))))
      (GoalScores $all-score $individual-score $collective-score)))

(= (gc-goal-analysis $goals $satisfied)
   (let* (
      ($goal-count (size-atom (noeval $goals)))
      ($satisfied-count (size-atom (noeval $satisfied)))
      ($small-input (and (<= $goal-count 8) (<= $satisfied-count 8)))
      ($use-native
         (if $small-input
             (and
                (gc-goal-identities-simple $goals)
                (gc-identities-simple $satisfied))
             False))
      ($structural-valid (if $use-native (gc-goal-input-valid $goals) True)))
      (if $structural-valid
          (if $use-native
           (let* (
              ($sums (gc-goal-sums $goals $satisfied))
              ($missing (gc-required-missing $goals $satisfied)))
              (gc-finalize-goal-analysis $sums $missing))
           (let
              (GoalFold
                 $total
                 $covered
                 $individual-total
                 $individual-covered
                 $collective-total
                 $collective-covered
                 $missing)
              (gc-goal-fold-atom (noeval $goals) (noeval $satisfied))
              (gc-finalize-goal-analysis
                 (GoalSums
                    $total
                    $covered
                    $individual-total
                    $individual-covered
                    $collective-total
                    $collective-covered)
                 $missing)))
          (noeval (InvalidGoalAnalysis)))))

; Evidence projection, scoring, ranking, and tie handling.

(= (gc-evidence-expectation $strength $confidence)
   (+ (* $confidence (- $strength 0.5)) 0.5))

; The host provides exact Python-compatible rounding over the binary64 input.
(= (gc-round3-nonnegative $value)
   (gc-round-number-atom $value 3))

(= (gc-default-risk $strength)
   (gc-round3-nonnegative (- 1.0 $strength)))

(= (gc-score-motivation $deontic $strength $confidence $motivation)
   (if (or (== $deontic forbidden) (== $deontic conflict))
       -1.0
       (+
          (+ (* 0.54 $motivation) (* 0.38 (* $strength $confidence)))
          (if (== $deontic obligated) 0.1 0.0))))

(= (gc-score-coverage $deontic $strength $confidence $goal-score $individual-score $collective-score)
   (if (or (== $deontic forbidden) (== $deontic conflict))
       -1.0
       (+
          (+
             (+ (* 0.42 $goal-score) (* 0.38 (* $strength $confidence)))
             (* 0.12 (gc-min $individual-score $collective-score)))
          (if (== $deontic obligated) 0.1 0.0))))

(= (gc-decision-status $deontic $score $missing-count)
   (if (or (== $deontic forbidden) (== $deontic conflict))
       blocked
       (if (and (>= $score 0.72) (== $missing-count 0))
           recommended
           (if (>= $score 0.5) candidate weak))))

(= (gc-decide-motivation $deontic $strength $confidence $motivation $missing-count)
   (let* (
      ($score (gc-score-motivation $deontic $strength $confidence $motivation))
      ($status (gc-decision-status $deontic $score $missing-count)))
      (NativeDecision $score $status)))

(= (gc-score-choice
      $deontic
      $strength
      $confidence
      $goal-score
      $individual-score
      $collective-score
      (Motivation $motivation))
   (gc-score-motivation $deontic $strength $confidence $motivation))

(= (gc-score-choice
      $deontic
      $strength
      $confidence
      $goal-score
      $individual-score
      $collective-score
      (NoMotivation))
   (gc-score-coverage
      $deontic
      $strength
      $confidence
      $goal-score
      $individual-score
      $collective-score))

; Evaluate one already-resolved action. The host supplies validated atoms and
; external evidence, while MeTTa owns every policy and scoring conclusion.
(= (gc-evaluate-action
      $goals
      (Action $action $label $satisfied)
      $resolution
      $evidence
      $motivation)
   (let $analysis (gc-goal-analysis $goals $satisfied)
        (gc-evaluate-action-analysis
           (Action $action $label $satisfied)
           $resolution
           $evidence
           $motivation
           $analysis)))

(= (gc-evaluate-action-analysis
      (Action $action $label $satisfied)
      $resolution
      $evidence
      $motivation
      (GoalAnalysis $goal-score $individual-score $collective-score $missing))
   (gc-evaluate-action-conclusion
      $action
      $label
      $satisfied
      $resolution
      $evidence
      $motivation
      $goal-score
      $individual-score
      $collective-score
      $missing
      (gc-expression-length $missing)))

(= (gc-evaluate-action-analysis
      (AnalyzedAction $action $label)
      $resolution
      $evidence
      $motivation
      (GoalAnalysisSummary
         $goal-score
         $individual-score
         $collective-score
         $missing-count))
   (gc-evaluate-action-conclusion
      $action
      $label
      (AnalyzedSatisfaction)
      $resolution
      $evidence
      $motivation
      $goal-score
      $individual-score
      $collective-score
      (AnalyzedMissing)
      $missing-count))

(= (gc-evaluate-action-conclusion
      $action
      $label
      $satisfied
      (NormResolution $declared-status $priority $norm-reasons)
      (Evidence $strength $confidence $source $projection $proofs $reasoner-status)
      $motivation
      $goal-score
      $individual-score
      $collective-score
      $missing
      $missing-count)
   (let* (
      ($status (gc-merge-norm-status $declared-status $reasoner-status))
      ($score
         (gc-score-choice
            $status
            $strength
            $confidence
            $goal-score
            $individual-score
            $collective-score
            $motivation))
      ($decision-status
         (gc-decision-status $status $score $missing-count))
      ($expectation (gc-evidence-expectation $strength $confidence)))
      (noeval (DecisionResult
         $action
         $label
         $decision-status
         $score
         $goal-score
         $individual-score
         $collective-score
         $expectation
         $status
         $priority
         $norm-reasons
         $reasoner-status
         $satisfied
         $missing))))

(= (gc-decision-row
      $order
      (DecisionResult
         $action
         $label
         $status
         $score
         $goal-score
         $individual-score
         $collective-score
         $expectation
         $norm-status
         $priority
         $norm-reasons
         $reasoner-status
         $satisfied
         $missing))
   (DecisionRow $action $order $score $status))

(= (gc-evaluate-request
      (EvaluateRequest $order $goals $action $resolution $evidence $motivation))
   (let* (
      ($decision
         (gc-evaluate-action
            $goals
            $action
            $resolution
            $evidence
            $motivation))
      ($row (gc-decision-row $order $decision)))
      (noeval (EvaluationBatch
         ((EvaluatedDecision $order $decision))
         ($row)))))

(= (gc-evaluate-request
      (EvaluateAnalyzedRequest
         $order
         $action
         $resolution
         $evidence
         $motivation
         $analysis))
   (let* (
      ($decision
         (gc-evaluate-action-analysis
            $action
            $resolution
            $evidence
            $motivation
            $analysis))
      ($row (gc-decision-row $order $decision)))
      (noeval (EvaluationBatch
         ((EvaluatedDecision $order $decision))
         ($row)))))

(= (gc-evaluate-request-range $requests $start $end)
   (if (== $start $end)
       (EvaluationBatch () ())
       (if (== (+ $start 1) $end)
           (gc-evaluate-request (index-atom (noeval $requests) $start))
           (let* (
              ($middle (floor-math (/ (+ $start $end) 2)))
              ((EvaluationBatch $left-evaluated $left-rows)
                 (gc-evaluate-request-range $requests $start $middle))
              ((EvaluationBatch $right-evaluated $right-rows)
                 (gc-evaluate-request-range $requests $middle $end)))
              (EvaluationBatch
                 (append $left-evaluated $right-evaluated)
                 (append $left-rows $right-rows))))))

(= (gc-evaluate-requests $requests)
   (let (EvaluationBatch $evaluated $rows)
      (gc-evaluate-request-range $requests 0 (size-atom (noeval $requests)))
      $evaluated))

(= (gc-decision-row-range $evaluated $start $end)
   (if (== $start $end)
       ()
       (if (== (+ $start 1) $end)
           (let
              (EvaluatedDecision $order $decision)
              (index-atom (noeval $evaluated) $start)
              ((gc-decision-row $order $decision)))
           (let* (
              ($middle (floor-math (/ (+ $start $end) 2)))
              ($left (gc-decision-row-range $evaluated $start $middle))
              ($right (gc-decision-row-range $evaluated $middle $end)))
              (append $left $right)))))

(= (gc-decision-rows $evaluated)
   (gc-decision-row-range $evaluated 0 (size-atom (noeval $evaluated))))

(= (gc-decision-sort-key
      (DecisionRow $action $order $score $status))
   (let $descending-score (- 0.0 $score)
      (noeval (DecisionSortKey
         $descending-score
         $order
         (DecisionRow $action $order $score $status)))))

(= (gc-decision-sort-row
      (DecisionSortKey $descending-score $order $row))
   (noeval $row))

(= (gc-sort-decisions $rows)
   (let* (
      ($keys
         (map-atom $rows $row (gc-decision-sort-key $row)))
      ($sorted-keys (msort $keys)))
      (map-atom $sorted-keys $key (gc-decision-sort-row $key))))

(= (gc-decision-row-tied
      $best-score
      $epsilon
      (DecisionRow $action $order $score $status))
   (gc-score-tied $best-score $score $epsilon))

(= (gc-decision-row-action
      (DecisionRow $action $order $score $status))
   (noeval $action))

(= (gc-tied-actions-from $best-score $rows $epsilon)
   (let $tied-rows
      (filter-atom
         $rows
         $row
         (gc-decision-row-tied $best-score $epsilon $row))
      (map-atom $tied-rows $row (gc-decision-row-action $row))))

(= (gc-score-tied $best-score $score $epsilon)
   (<= (gc-abs (- $score $best-score)) $epsilon))

(= (gc-decision-rows-valid $rows $actions $orders)
   (if (== $rows ())
       True
       (let* (
          (($head $tail) (decons-atom $rows))
          ((DecisionRow $action $order $score $status) $head))
          (and
             (and
                (and
                   (and
                      (and (gc-finite-number $order) (>= $order 0))
                      (and
                         (== (floor-math $order) $order)
                         (<= $order 9007199254740991)))
                   (and
                      (gc-finite-number $score)
                      (not (gc-expression-contains $order $orders))))
                (and
                   (not (gc-expression-contains $action $actions))
                   (or
                      (or (== $status blocked) (== $status recommended))
                      (or (== $status candidate) (== $status weak)))))
             (gc-decision-rows-valid
                $tail
                (cons-atom $action $actions)
                (cons-atom $order $orders))))))

(= (gc-rank-decisions $rows $epsilon)
   (let* (
      ($row-count (size-atom (noeval $rows)))
      ($small-input (<= $row-count 8))
      ($use-native
         (if $small-input
             (gc-decision-identities-simple $rows)
             False))
      ($structural-valid
         (if $use-native
             (gc-decision-rows-valid $rows () ())
             True)))
      (if (and
            (and
               (> $row-count 0)
               (and (gc-finite-number $epsilon) (>= $epsilon 0.0)))
            $structural-valid)
          (let* (
             ((BulkRanking $ranked $tied $tied-count)
                (if $use-native
                    (let* (
                       ($native-ranked (gc-sort-decisions $rows))
                       (($native-best $native-tail) (decons-atom $native-ranked))
                       ((DecisionRow $native-action $native-order $native-score $native-status)
                          $native-best)
                       ($native-tied
                          (gc-tied-actions-from $native-score $native-ranked $epsilon)))
                       (BulkRanking
                          $native-ranked
                          $native-tied
                          (gc-expression-length $native-tied)))
                    (gc-rank-decision-rows-atom (noeval $rows) $epsilon)))
             (($best $tail) (decons-atom $ranked))
             ((DecisionRow $best-action $best-order $best-score $best-status) $best)
             ($automatic
                (gc-automatic-execution-allowed
                   $best-status
                   $tied-count)))
             (noeval (RankedDecisions $ranked $tied $automatic)))
          (noeval (InvalidDecisionRanking)))))

(= (gc-automatic-execution-allowed $best-status $tied-count)
   (and (== $best-status recommended) (== $tied-count 1)))

(= (gc-evaluate-and-rank $requests $epsilon)
   (let* (
      ((EvaluationBatch $evaluated $rows)
         (gc-evaluate-request-range $requests 0 (size-atom (noeval $requests))))
      ($ranking (gc-rank-decisions $rows $epsilon)))
      (noeval (ScenarioEvaluation $evaluated $ranking))))

(= (gc-selection-label $status $is-top $is-tied)
   (if (== $status blocked)
       blocked
       (if (and $is-top $is-tied)
           tied
           (if $is-top selected not-selected))))

; Individual and collective motivation consensus.

(: gc-motivation-mask-native (-> Atom Atom %Undefined%))
(= (gc-goal-kind-mask
      $selected-kind
      (Goal $id $kind $weight $required))
   (if (== $kind $selected-kind) 1.0 0.0))

(= (gc-motivation-mask-native $selected-kind $goals)
   (map-atom $goals $goal (gc-goal-kind-mask $selected-kind $goal)))

(: gc-motivation-mask (-> Atom Atom %Undefined%))
(= (gc-motivation-mask $selected-kind $goals)
   (if (<= (size-atom (noeval $goals)) 8)
       (gc-motivation-mask-native $selected-kind $goals)
       (gc-goal-mask-atom $selected-kind $goals)))

(= (gc-valid-correlation $value)
   (if (gc-finite-number $value)
       (if (>= $value -1.0) (<= $value 1.0) False)
       False))

(= (gc-valid-probability $value)
   (if (gc-finite-number $value)
       (if (>= $value 0.0) (<= $value 1.0) False)
       False))

(= (gc-mask-number-valid-step $valid $value)
   (and $valid (gc-valid-probability $value)))

(= (gc-number-vector-valid $values)
   (foldl-atom
      $values
      True
      $valid
      $value
      (gc-mask-number-valid-step $valid $value)))

(= (gc-correlation-number-valid-step $valid $value)
   (and $valid (gc-valid-correlation $value)))

(= (gc-correlation-numbers-valid $values)
   (foldl-atom
      $values
      True
      $valid
      $value
      (gc-correlation-number-valid-step $valid $value)))

(= (gc-identity-valid $id)
   (is-ground $id))

(= (gc-motivation-candidates-valid $candidates $goal-count)
   (if (== (noeval $candidates) ())
       True
       (let* (
          (($head $tail) (decons-atom $candidates)))
          (unify
             $head
             (Candidate $id $correlations $risk)
             (if (gc-identity-valid $id)
                 (if (== (get-mettatype $correlations) Expression)
                     (if (==
                           (size-atom (noeval $correlations))
                           $goal-count)
                         (if (gc-correlation-numbers-valid $correlations)
                             (if (gc-valid-probability $risk)
                                 (gc-motivation-candidates-valid
                                    $tail
                                    $goal-count)
                                 False)
                             False)
                         False)
                     False)
                 False)
             False))))

; Standalone MeTTa uses the bounded native path. The TypeScript host overrides
; this structural selector so reducible terms are normalized exactly once.
(= (gc-motivation-inputs-simple-atom $individual $collective $candidates)
   True)

(= (gc-correlation-value (ExplicitCorrelation $value))
   $value)

(= (gc-correlation-value (DefaultCorrelation True)) 1.0)

(= (gc-correlation-value (DefaultCorrelation False)) 0.0)

(= (gc-correlation-spec-valid (ExplicitCorrelation $value))
   (gc-valid-correlation $value))

(= (gc-correlation-spec-valid (DefaultCorrelation True)) True)

(= (gc-correlation-spec-valid (DefaultCorrelation False)) True)

(= (gc-correlation-valid-step $valid $spec)
   (and $valid (gc-correlation-spec-valid $spec)))

(= (gc-correlation-specs-valid $specs)
   (foldl-atom
      $specs
      True
      $valid
      $spec
      (gc-correlation-valid-step $valid $spec)))

(: gc-motivation-correlations-native (-> Atom %Undefined%))
(= (gc-motivation-correlations-native $specs)
   (map-atom $specs $spec (gc-correlation-value $spec)))

(: gc-motivation-correlations (-> Atom %Undefined%))
(= (gc-motivation-correlations $specs)
   (if (<= (size-atom (noeval $specs)) 8)
       (gc-motivation-correlations-native $specs)
       (gc-correlation-values-atom $specs)))

(= (gc-motivation-risk (ExplicitRisk $risk))
   (let True (gc-valid-probability $risk) $risk))

(= (gc-motivation-risk (DefaultRisk $strength))
   (let True (gc-valid-probability $strength) (gc-default-risk $strength)))

(= (gc-motivation-risk-valid (ExplicitRisk $risk))
   (gc-valid-probability $risk))

(= (gc-motivation-risk-valid (DefaultRisk $strength))
   (gc-valid-probability $strength))

(= (gc-motivation-candidate
      (MotivationAction $id $correlation-specs $risk-spec))
   (let* (
      ($native-correlations
         (<= (size-atom (noeval $correlation-specs)) 8))
      ($valid
         (and
            (gc-motivation-risk-valid $risk-spec)
            (if $native-correlations
                (gc-correlation-specs-valid $correlation-specs)
                True))))
      (if $valid
          (let* (
             ($correlations (gc-motivation-correlations $correlation-specs))
             ($risk (gc-motivation-risk $risk-spec)))
             (if $native-correlations
                 (noeval (Candidate $id $correlations $risk))
                 (gc-pack-candidate-atom $id $correlations $risk)))
          (noeval (InvalidMotivationCandidate)))))

(= (gc-candidate-score $weights (Candidate $id $correlations $risk) $with-risk)
   (- (gc-dot $weights $correlations) (if $with-risk $risk 0.0)))

(= (gc-candidate-id (Candidate $id $correlations $risk)) $id)

(= (gc-consensus-id (ConsensusScore $id $score)) $id)

(= (gc-consensus-value (ConsensusScore $id $score)) $score)

(= (gc-best-candidate-step
      $weights
      $with-risk
      (BestCandidate $best-id $best-score)
      $candidate)
   (let* (
      ($id (gc-candidate-id $candidate))
      ($score (gc-candidate-score $weights $candidate $with-risk)))
      (if (> $score $best-score)
          (noeval (BestCandidate $id $score))
          (noeval (BestCandidate $best-id $best-score)))))

(= (gc-best-candidate-loop
      $weights
      $with-risk
      $best-id
      $best-score
      $remaining)
   (if (== (noeval $remaining) ())
       (noeval (BestCandidate $best-id $best-score))
       (let* (
          (($head $tail) (decons-atom $remaining))
          ($id (gc-candidate-id $head))
          ($score (gc-candidate-score $weights $head $with-risk)))
          (if (> $score $best-score)
              (gc-best-candidate-loop
                 $weights
                 $with-risk
                 $id
                 $score
                 $tail)
              (gc-best-candidate-loop
                 $weights
                 $with-risk
                 $best-id
                 $best-score
                 $tail)))))

(= (gc-best-candidate $weights $candidates $with-risk)
   (if (== (noeval $candidates) ())
       (NoCandidate)
       (let* (
          (($head $tail) (decons-atom $candidates))
          ($id (gc-candidate-id $head))
          ($score (gc-candidate-score $weights $head $with-risk)))
          (if (<= (size-atom (noeval $weights)) 8)
              (foldl-atom
                 $tail
                 (BestCandidate $id $score)
                 $best
                 $candidate
                 (gc-best-candidate-step
                    $weights
                    $with-risk
                    $best
                    $candidate))
              (gc-best-candidate-loop
                 $weights
                 $with-risk
                 $id
                 $score
                 $tail)))))

(= (gc-optional-best $available (BestCandidate $id $score))
   (if $available (noeval (Some $id)) (noeval (None))))

(= (gc-consensus-score
      $individual
      $collective
      (Candidate $id $correlations $risk)
      $individual-available
      $collective-available)
   (let* (
      ($individual-pull (gc-dot $individual $correlations))
      ($collective-pull (gc-dot $collective $correlations))
      ($individual-score (- $individual-pull $risk))
      ($collective-score (- $collective-pull $risk)))
      (gc-consensus-from-scores
         $individual-score
         $collective-score
         $individual-available
         $collective-available)))

(= (gc-consensus-from-scores
      $individual-score
      $collective-score
      $individual-available
      $collective-available)
   (if (and $individual-available $collective-available)
       (- (/ (+ $individual-score $collective-score) 2.0)
          (* 0.25 (gc-abs (- $individual-score $collective-score))))
       (if $individual-available $individual-score $collective-score)))

(= (gc-motivation-availability $individual $collective)
   (let* (
      ($individual-available (> (gc-sum $individual) 0.0))
      ($collective-available (> (gc-sum $collective) 0.0)))
      (noeval (MotivationAvailability
         $individual-available
         $collective-available))))

(= (gc-motivation-score-row
      $individual
      $collective
      (Candidate $id $correlations $risk)
      $individual-available
      $collective-available)
   (let* (
      ($individual-pull (gc-dot $individual $correlations))
      ($collective-pull (gc-dot $collective $correlations))
      ($individual-preference (- $individual-pull $risk))
      ($collective-preference (- $collective-pull $risk))
      ($consensus
         (gc-consensus-from-scores
            $individual-preference
            $collective-preference
            $individual-available
            $collective-available)))
      (noeval (MotivationScoreRow
         $id
         $individual-pull
         $collective-pull
         $individual-preference
         $collective-preference
         $consensus))))

(= (gc-motivation-fold-pull-tree
      $individual-available
      $collective-available
      (MotivationPullLeaf $id $individual-pull $collective-pull $risk))
   (let* (
      ($individual-preference (- $individual-pull $risk))
      ($collective-preference (- $collective-pull $risk))
      ($consensus
         (gc-consensus-from-scores
            $individual-preference
            $collective-preference
            $individual-available
            $collective-available)))
      (noeval (MotivationFoldState
         (MotivationBestSet
            (BestCandidate $id $individual-pull)
            (BestCandidate $id $collective-pull)
            (BestCandidate $id $individual-preference)
            (BestCandidate $id $collective-preference)
            (BestCandidate $id $consensus))
         (MotivationConsensusLeaf (ConsensusScore $id $consensus))))))

(= (gc-motivation-fold-pull-tree
      $individual-available
      $collective-available
      (MotivationPullNode $left $right))
   (let* (
      ($left-state
         (gc-motivation-fold-pull-tree
            $individual-available
            $collective-available
            $left))
      ($right-state
         (gc-motivation-fold-pull-tree
            $individual-available
            $collective-available
            $right)))
      (gc-motivation-fold-merge $left-state $right-state)))

(= (gc-motivation-consensus-canonical
      $individual
      $collective
      $candidates)
   (let* (
      ((MotivationAvailability $individual-available $collective-available)
         (gc-motivation-availability $individual $collective))
      ($pull-tree
         (gc-motivation-pull-tree-atom
            (noeval $individual)
            (noeval $collective)
            (noeval $candidates)))
      ($state
         (gc-motivation-fold-pull-tree
            $individual-available
            $collective-available
            $pull-tree)))
      (gc-motivation-finalize
         $individual-available
         $collective-available
         $state)))

(= (gc-consensus-score-row
      $individual
      $collective
      $individual-available
      $collective-available
      $candidate)
   (let* (
      ($id (gc-candidate-id $candidate))
      ($score
         (gc-consensus-score
            $individual
            $collective
            $candidate
            $individual-available
            $collective-available)))
      (noeval (ConsensusScore $id $score))))

(= (gc-consensus-scores
      $individual
      $collective
      $candidates
      $individual-available
      $collective-available)
   (if (and
         (<= (size-atom (noeval $individual)) 8)
         (<= (size-atom (noeval $collective)) 8))
       (map-atom
          $candidates
          $candidate
          (gc-consensus-score-row
             $individual
             $collective
             $individual-available
             $collective-available
             $candidate))
       (gc-consensus-scores-loop
          $individual
          $collective
          $candidates
          $individual-available
          $collective-available)))

(= (gc-consensus-scores-loop
      $individual
      $collective
      $candidates
      $individual-available
      $collective-available)
   (if (== (noeval $candidates) ())
       ()
       (let* (
          (($head $tail) (decons-atom $candidates))
          ($id (gc-candidate-id $head))
          ($score
             (gc-consensus-score
                $individual
                $collective
                $head
                $individual-available
                $collective-available)))
          (if (== (noeval $tail) ())
              ((ConsensusScore $id $score))
              (let $tail-scores
                 (gc-consensus-scores-loop
                    $individual
                    $collective
                    $tail
                    $individual-available
                    $collective-available)
                 (cons-atom (ConsensusScore $id $score) $tail-scores))))))

(= (gc-best-consensus-step
      (BestCandidate $best-id $best-score)
      (ConsensusScore $id $score))
   (if (> $score $best-score)
       (noeval (BestCandidate $id $score))
       (noeval (BestCandidate $best-id $best-score))))

(= (gc-best-consensus $scores)
   (let* (
      (($head $tail) (decons-atom $scores))
      ($id (gc-consensus-id $head))
      ($score (gc-consensus-value $head)))
      (foldl-atom
         $tail
         (BestCandidate $id $score)
         $best
         $candidate
         (gc-best-consensus-step $best $candidate))))

(= (gc-motivation-consensus-native $individual $collective $candidates)
   (let* (
      ($individual-available (> (gc-sum $individual) 0.0))
      ($collective-available (> (gc-sum $collective) 0.0))
      ($individual-pull (gc-optional-best $individual-available (gc-best-candidate $individual $candidates False)))
      ($collective-pull (gc-optional-best $collective-available (gc-best-candidate $collective $candidates False)))
      ($individual-preference (gc-optional-best $individual-available (gc-best-candidate $individual $candidates True)))
      ($collective-preference (gc-optional-best $collective-available (gc-best-candidate $collective $candidates True)))
      ($scores (gc-consensus-scores $individual $collective $candidates $individual-available $collective-available))
      ((BestCandidate $consensus $consensus-score) (gc-best-consensus $scores)))
      (MotivationResult
         $individual-pull
         $collective-pull
         $individual-preference
         $collective-preference
         $scores
         $consensus)))

; Large candidate sets are shaped into a balanced tree by the host. MeTTa
; computes every score, maximum, availability choice, and final consensus.
(= (gc-motivation-best-set-merge
      (MotivationBestSet
         (BestCandidate $left-individual-pull-id $left-individual-pull-score)
         (BestCandidate $left-collective-pull-id $left-collective-pull-score)
         (BestCandidate
            $left-individual-preference-id
            $left-individual-preference-score)
         (BestCandidate
            $left-collective-preference-id
            $left-collective-preference-score)
         (BestCandidate $left-consensus-id $left-consensus-score))
      (MotivationBestSet
         (BestCandidate $right-individual-pull-id $right-individual-pull-score)
         (BestCandidate $right-collective-pull-id $right-collective-pull-score)
         (BestCandidate
            $right-individual-preference-id
            $right-individual-preference-score)
         (BestCandidate
            $right-collective-preference-id
            $right-collective-preference-score)
         (BestCandidate $right-consensus-id $right-consensus-score)))
   (let* (
      ($individual-pull-right
         (> $right-individual-pull-score $left-individual-pull-score))
      ($individual-pull-id
         (if $individual-pull-right
             $right-individual-pull-id
             $left-individual-pull-id))
      ($individual-pull-score
         (if $individual-pull-right
             $right-individual-pull-score
             $left-individual-pull-score))
      ($collective-pull-right
         (> $right-collective-pull-score $left-collective-pull-score))
      ($collective-pull-id
         (if $collective-pull-right
             $right-collective-pull-id
             $left-collective-pull-id))
      ($collective-pull-score
         (if $collective-pull-right
             $right-collective-pull-score
             $left-collective-pull-score))
      ($individual-preference-right
         (> $right-individual-preference-score $left-individual-preference-score))
      ($individual-preference-id
         (if $individual-preference-right
             $right-individual-preference-id
             $left-individual-preference-id))
      ($individual-preference-score
         (if $individual-preference-right
             $right-individual-preference-score
             $left-individual-preference-score))
      ($collective-preference-right
         (> $right-collective-preference-score $left-collective-preference-score))
      ($collective-preference-id
         (if $collective-preference-right
             $right-collective-preference-id
             $left-collective-preference-id))
      ($collective-preference-score
         (if $collective-preference-right
             $right-collective-preference-score
             $left-collective-preference-score))
      ($consensus-right (> $right-consensus-score $left-consensus-score))
      ($consensus-id
         (if $consensus-right $right-consensus-id $left-consensus-id))
      ($consensus-score
         (if $consensus-right $right-consensus-score $left-consensus-score)))
      (noeval (MotivationBestSet
         (BestCandidate $individual-pull-id $individual-pull-score)
         (BestCandidate $collective-pull-id $collective-pull-score)
         (BestCandidate $individual-preference-id $individual-preference-score)
         (BestCandidate $collective-preference-id $collective-preference-score)
         (BestCandidate $consensus-id $consensus-score)))))

(= (gc-motivation-fold-merge
      (MotivationFoldState $left-best $left-scores)
      (MotivationFoldState $right-best $right-scores))
   (let $best (gc-motivation-best-set-merge $left-best $right-best)
      (noeval (MotivationFoldState
         $best
         (MotivationConsensusNode $left-scores $right-scores)))))

(= (gc-motivation-state-from-score-row
      (MotivationScoreRow
         $id
         $individual-pull
         $collective-pull
         $individual-preference
         $collective-preference
         $consensus))
   (noeval (MotivationFoldState
      (MotivationBestSet
         (BestCandidate $id $individual-pull)
         (BestCandidate $id $collective-pull)
         (BestCandidate $id $individual-preference)
         (BestCandidate $id $collective-preference)
         (BestCandidate $id $consensus))
      (MotivationConsensusLeaf (ConsensusScore $id $consensus)))))

(= (gc-motivation-fold-score-tree
      (MotivationScoreLeaf $row))
   (gc-motivation-state-from-score-row $row))

(= (gc-motivation-fold-score-tree
      (MotivationScoreNode $left $right))
   (let* (
      ($left-state (gc-motivation-fold-score-tree $left))
      ($right-state (gc-motivation-fold-score-tree $right)))
      (gc-motivation-fold-merge $left-state $right-state)))

(= (gc-motivation-finalize
      $individual-available
      $collective-available
      (MotivationFoldState
         (MotivationBestSet
            $individual-pull-best
            $collective-pull-best
            $individual-preference-best
            $collective-preference-best
            (BestCandidate $consensus $consensus-score))
         $score-tree))
   (let* (
      ($individual-pull
         (gc-optional-best $individual-available $individual-pull-best))
      ($collective-pull
         (gc-optional-best $collective-available $collective-pull-best))
      ($individual-preference
         (gc-optional-best
            $individual-available
            $individual-preference-best))
      ($collective-preference
         (gc-optional-best
            $collective-available
            $collective-preference-best))
      ($scores (gc-flatten-motivation-consensus-tree-atom $score-tree)))
      (noeval (MotivationResult
         $individual-pull
         $collective-pull
         $individual-preference
         $collective-preference
         $scores
         $consensus))))

(= (gc-motivation-aggregate $rows $individual-available $collective-available)
   (let* (
      ($score-tree (gc-motivation-score-tree-atom (noeval $rows)))
      ($state (gc-motivation-fold-score-tree $score-tree)))
      (gc-motivation-finalize
         $individual-available
         $collective-available
         $state)))

(= (gc-candidate-identities-unique $candidates)
   (gc-candidate-identities-unique-loop $candidates ()))

(= (gc-candidate-identities-unique-loop $candidates $seen)
   (if (== (noeval $candidates) ())
       True
       (let* (
          (($head $tail) (decons-atom $candidates))
          ($id (gc-candidate-id $head)))
          (if (is-member $id $seen)
              False
              (gc-candidate-identities-unique-loop
                 $tail
                 (cons-atom $id $seen))))))

(= (gc-motivation-consensus-expressions $individual $collective $candidates)
   (let $candidate-count (size-atom (noeval $candidates))
      (if (> $candidate-count 0)
          (let $large-input
             (or
                (> $candidate-count 8)
                (or
                   (> (size-atom (noeval $individual)) 8)
                   (> (size-atom (noeval $collective)) 8)))
             (if $large-input
                 (gc-motivation-consensus-bridge-atom
                    (noeval $individual)
                    (noeval $collective)
                    (noeval $candidates))
                 (if (not
                       (gc-motivation-inputs-simple-atom
                          (noeval $individual)
                          (noeval $collective)
                          (noeval $candidates)))
                     (gc-motivation-consensus-bridge-atom
                        (noeval $individual)
                        (noeval $collective)
                        (noeval $candidates))
                     (let $goal-count
                        (size-atom (noeval $individual))
                        (if (and
                              (and
                                 (==
                                    (size-atom (noeval $collective))
                                    $goal-count)
                                 (and
                                    (gc-number-vector-valid $individual)
                                    (gc-number-vector-valid $collective)))
                              (gc-motivation-candidates-valid
                                 $candidates
                                 $goal-count))
                            (if (gc-candidate-identities-unique $candidates)
                                (gc-motivation-consensus-native
                                   $individual
                                   $collective
                                   $candidates)
                                (noeval (InvalidMotivationConsensus)))
                            (noeval (InvalidMotivationConsensus)))))))
          (noeval (InvalidMotivationConsensus)))))

(= (gc-motivation-consensus $individual $collective $candidates)
   (if (== (get-mettatype $individual) Expression)
       (if (== (get-mettatype $collective) Expression)
           (if (== (get-mettatype $candidates) Expression)
               (gc-motivation-consensus-expressions
                  $individual
                  $collective
                  $candidates)
               (noeval (InvalidMotivationConsensus)))
           (noeval (InvalidMotivationConsensus)))
       (noeval (InvalidMotivationConsensus))))

; PLN-style truth-value deduction and revision.

(= (gc-pln-rules-valid $rules)
   (if (== $rules ())
       True
       (let* (
          (($head $tail) (decons-atom $rules))
          ((PlnRule $id $predicate $strength $confidence) $head))
          (and
             (and
                (and (gc-finite-number $strength) (gc-finite-number $confidence))
                (and
                   (and (>= $strength 0.0) (<= $strength 1.0))
                   (and (>= $confidence 0.0) (<= $confidence 1.0))))
             (gc-pln-rules-valid $tail)))))

(= (gc-pln-facts-valid $facts)
   (if (== $facts ())
       True
       (let* (
          (($head $tail) (decons-atom $facts))
          ((PlnFact $id $action $predicate $strength $confidence) $head))
          (and
             (and
                (and (gc-finite-number $strength) (gc-finite-number $confidence))
                (and
                   (and (>= $strength 0.0) (<= $strength 1.0))
                   (and (>= $confidence 0.0) (<= $confidence 1.0))))
             (gc-pln-facts-valid $tail)))))

(= (gc-confidence-weight $confidence)
   (/ (* $confidence 800.0) (- 1.0 (gc-min $confidence 0.9999))))

(= (gc-pln-deduced-strength $rule-strength $fact-strength)
   (+ (* $rule-strength $fact-strength) (* 0.2 (- 1.0 $fact-strength))))

(= (gc-pln-deduced-confidence $rule-confidence $fact-confidence $fact-strength)
   (+
      (* $fact-strength (gc-min $rule-confidence $fact-confidence))
      (* (- 1.0 $fact-strength) (gc-min 0.2 $fact-confidence))))

(= (gc-pln-deduction $rule-id $fact-id $rule-strength $rule-confidence $fact-strength $fact-confidence)
   (let* (
      ($strength (gc-pln-deduced-strength $rule-strength $fact-strength))
      ($confidence (gc-pln-deduced-confidence $rule-confidence $fact-confidence $fact-strength)))
      (Deduced $rule-id $fact-id $strength $confidence)))

(= (gc-pln-deductions-for-fact $action (PlnFact $fact-id $fact-action $predicate $fact-strength $fact-confidence) $rules)
   (if (== $rules ())
       ()
       (let* (
          (($head $tail) (decons-atom $rules))
          ((PlnRule $rule-id $rule-predicate $rule-strength $rule-confidence) $head)
          ($tail-deductions (gc-pln-deductions-for-fact $action (PlnFact $fact-id $fact-action $predicate $fact-strength $fact-confidence) $tail)))
          (if (and
                (noreduce-eq $action $fact-action)
                (noreduce-eq $predicate $rule-predicate))
              (let $deduction (gc-pln-deduction $rule-id $fact-id $rule-strength $rule-confidence $fact-strength $fact-confidence)
                   (cons-atom $deduction $tail-deductions))
              $tail-deductions))))

(= (gc-pln-deductions-for-rule
      $action
      (PlnRule $rule-id $rule-predicate $rule-strength $rule-confidence)
      $facts)
   (if (== (noeval $facts) ())
       ()
       (let* (
          (($head $tail) (decons-atom $facts))
          ((PlnFact $fact-id $fact-action $predicate $fact-strength $fact-confidence) $head)
          ($tail-deductions
             (gc-pln-deductions-for-rule
                $action
                (PlnRule $rule-id $rule-predicate $rule-strength $rule-confidence)
                $tail)))
          (if (and
                (noreduce-eq $action $fact-action)
                (noreduce-eq $predicate $rule-predicate))
              (let $deduction
                 (gc-pln-deduction
                    $rule-id
                    $fact-id
                    $rule-strength
                    $rule-confidence
                    $fact-strength
                    $fact-confidence)
                 (cons-atom $deduction $tail-deductions))
              $tail-deductions))))

(= (gc-pln-deductions $action $rules $facts)
   (if (== (noeval $rules) ())
       ()
       (let* (
          (($head $tail) (decons-atom $rules))
          ($head-deductions (gc-pln-deductions-for-rule $action $head $facts))
          ($tail-deductions (gc-pln-deductions $action $tail $facts)))
          (append $head-deductions $tail-deductions))))

(= (gc-pln-revise $left-strength $left-confidence $right-strength $right-confidence)
   (let* (
      ($left-weight (gc-confidence-weight $left-confidence))
      ($right-weight (gc-confidence-weight $right-confidence))
      ($total-weight (+ $left-weight $right-weight))
      ($strength
         (if (== $total-weight 0.0)
             0.5
             (/ (+ (* $left-strength $left-weight) (* $right-strength $right-weight)) $total-weight)))
      ($confidence (/ $total-weight (+ $total-weight 800.0))))
      (STV $strength $confidence)))

(= (gc-pln-revision-step
      (PlnNativeFold $strength $confidence $proof)
      (Deduced $rule-id $fact-id $next-strength $next-confidence))
   (let
      (STV $revised-strength $revised-confidence)
      (gc-pln-revise
         $strength
         $confidence
         $next-strength
         $next-confidence)
      (noeval (PlnNativeFold
         $revised-strength
         $revised-confidence
         (Revision $proof (RuleProof $rule-id $fact-id))))))

(= (gc-pln-belief $deductions)
   (if (== (noeval $deductions) ())
       (NoBelief)
       (let* (
          (($head $tail) (decons-atom $deductions))
          ((Deduced $rule-id $fact-id $strength $confidence) $head)
          ((PlnNativeFold $final-strength $final-confidence $proof)
             (foldl-atom
                $tail
                (PlnNativeFold
                   $strength
                   $confidence
                   (RuleProof $rule-id $fact-id))
                $state
                $deduction
                (gc-pln-revision-step $state $deduction))))
          (noeval (Belief $final-strength $final-confidence $proof)))))

(= (gc-pln-evaluate $action $rules $facts)
   (let* (
      ($rule-count (size-atom (noeval $rules)))
      ($fact-count (size-atom (noeval $facts))))
      (if (or (== $rule-count 0) (== $fact-count 0))
          (noeval (PlnResult (NoBelief) ()))
          (let* (
             ($small-input (<= (* $rule-count $fact-count) 8))
             ($use-native
                (if $small-input
                    (gc-pln-identities-simple $action $rules $facts)
                    False)))
             (if $use-native
                 (if (and (gc-pln-rules-valid $rules) (gc-pln-facts-valid $facts))
                     (let* (
                        ($deductions (gc-pln-deductions $action $rules $facts))
                        ($belief (gc-pln-belief $deductions)))
                        (PlnResult $belief $deductions))
                     (noeval (InvalidPlnProgram)))
                 (let $match-tree
                    (gc-pln-match-tree-atom $action (noeval $rules) (noeval $facts))
                    (gc-pln-evaluate-match-tree $match-tree)))))))

; Large programs use a host-built, order-preserving match tree. All truth
; arithmetic stays in the relations below.
(= (gc-pln-deduction-tree (PlnMatchEmpty))
   (noeval (PlnDeductionEmpty)))

(= (gc-pln-deduction-tree
      (PlnMatchLeaf
         $rule-id
         $fact-id
         $rule-strength
         $rule-confidence
         $fact-strength
         $fact-confidence))
   (let $deduction
      (gc-pln-deduction
         $rule-id
         $fact-id
         $rule-strength
         $rule-confidence
         $fact-strength
         $fact-confidence)
      (noeval (PlnDeductionLeaf $deduction))))

(= (gc-pln-deduction-tree (PlnMatchNode $left $right))
   (let* (
      ($left-tree (gc-pln-deduction-tree $left))
      ($right-tree (gc-pln-deduction-tree $right)))
      (noeval (PlnDeductionNode $left-tree $right-tree))))

(= (gc-pln-flatten-deduction-tree (PlnDeductionEmpty))
   ())

(= (gc-pln-flatten-deduction-tree (PlnDeductionLeaf $deduction))
   (cons-atom $deduction ()))

(= (gc-pln-flatten-deduction-tree (PlnDeductionNode $left $right))
   (append
      (gc-pln-flatten-deduction-tree $left)
      (gc-pln-flatten-deduction-tree $right)))

(= (gc-pln-fold-add
      (PlnFoldEmpty)
      (Deduced $rule-id $fact-id $strength $confidence))
   (noeval (PlnFoldValue $strength $confidence)))

(= (gc-pln-fold-add
      (PlnFoldValue $left-strength $left-confidence)
      (Deduced $rule-id $fact-id $right-strength $right-confidence))
   (let (STV $strength $confidence)
      (gc-pln-revise
         $left-strength
         $left-confidence
         $right-strength
         $right-confidence)
      (noeval (PlnFoldValue $strength $confidence))))

(= (gc-pln-fold-deduction-tree $state (PlnDeductionEmpty))
   $state)

(= (gc-pln-fold-deduction-tree $state (PlnDeductionLeaf $deduction))
   (gc-pln-fold-add $state $deduction))

(= (gc-pln-fold-deduction-tree $state (PlnDeductionNode $left $right))
   (let $left-state (gc-pln-fold-deduction-tree $state $left)
        (gc-pln-fold-deduction-tree $left-state $right)))

(= (gc-pln-proof-tree
      (PlnDeductionLeaf (Deduced $rule-id $fact-id $strength $confidence)))
   (noeval (RuleProof $rule-id $fact-id)))

(= (gc-pln-proof-tree (PlnDeductionNode $left $right))
   (let* (
      ($left-proof (gc-pln-proof-tree $left))
      ($right-proof (gc-pln-proof-tree $right)))
      (noeval (ProofSequenceNode $left-proof $right-proof))))

(= (gc-pln-proof (PlnDeductionLeaf $deduction))
   (gc-pln-proof-tree (PlnDeductionLeaf $deduction)))

(= (gc-pln-proof (PlnDeductionNode $left $right))
   (let $sequence
      (gc-pln-proof-tree (PlnDeductionNode $left $right))
      (noeval (RevisionSequence $sequence))))

(= (gc-pln-belief-tree (PlnDeductionEmpty))
   (NoBelief))

(= (gc-pln-belief-from-nonempty $tree)
   (let* (
      ((PlnFoldValue $strength $confidence)
         (gc-pln-fold-deduction-tree (PlnFoldEmpty) $tree))
      ($proof (gc-pln-proof $tree)))
      (Belief $strength $confidence $proof)))

(= (gc-pln-belief-tree (PlnDeductionLeaf $deduction))
   (gc-pln-belief-from-nonempty (PlnDeductionLeaf $deduction)))

(= (gc-pln-belief-tree (PlnDeductionNode $left $right))
   (gc-pln-belief-from-nonempty (PlnDeductionNode $left $right)))

(= (gc-pln-evaluate-match-tree $match-tree)
   (let* (
      ($deduction-tree (gc-pln-deduction-tree $match-tree))
      ($deductions (gc-pln-flatten-deduction-tree $deduction-tree))
      ($belief (gc-pln-belief-tree $deduction-tree)))
      (noeval (PlnResult $belief $deductions))))

; Subjective-Logic NARS opinions and two-premise deduction.

(= (gc-snars-opinion $positive $negative $base-rate)
   (let* (
      ($total (+ (+ $positive $negative) 2.0))
      ($belief (/ $positive $total))
      ($disbelief (/ $negative $total))
      ($uncertainty (/ 2.0 $total)))
      (Opinion $belief $disbelief $uncertainty $base-rate)))

(= (gc-opinion-expectation (Opinion $belief $disbelief $uncertainty $base-rate))
   (+ $belief (* $base-rate $uncertainty)))

(= (gc-snars-assess $subject $relation $object $source $positive $negative $base-rate)
   (let* (
      ($opinion (gc-snars-opinion $positive $negative $base-rate))
      ($expectation (gc-opinion-expectation $opinion)))
      (SnarsAssessment $subject $relation $object $source $opinion $expectation)))

(= (gc-snars-deduction $subject $middle $conclusion $source-one $source-two)
   (let* (
      ($premise-one (gc-snars-opinion 9.0 0.0 0.5))
      ($premise-two (gc-snars-opinion 9.0 0.0 0.5))
      ((Opinion $belief-one $disbelief-one $uncertainty-one $base-rate-one) $premise-one)
      ((Opinion $belief-two $disbelief-two $uncertainty-two $base-rate-two) $premise-two)
      ($belief (* $belief-one $belief-two))
      ($opinion (Opinion $belief 0.0 (- 1.0 $belief) 0.5))
      ($expectation (gc-opinion-expectation $opinion)))
      (SnarsDeduction
         $subject
         $middle
         $conclusion
         $source-one
         $source-two
         $premise-one
         $premise-two
         $opinion
         $expectation)))

; Directive classification and fact-backed claim lifecycle.

(= (gc-directive-task-state $status)
   (if (== $status obligated)
       ready
       (if (or (== $status forbidden) (== $status conflict))
           blocked
           (if (or (== $status permitted) (== $status unregulated))
               backlog
               invalid))))

(= (gc-directive-status-rows $state)
   (match &self
      (DirectiveTask $task $order $state $agent $rule)
      (DirectiveStatusRow $order $task)))

(= (gc-directive-status-rows claimed)
   (match &self
      (DirectiveClaim $task $agent $version)
      (match &self
         (DirectiveTask $task $order $state $assigned-agent $rule)
         (DirectiveStatusRow $order $task))))

(= (gc-directive-readiness $task)
   (match &self
      (DirectiveTask $task $order $state $agent $rule)
      $state))

(= (gc-directive-known-task $task)
   (match &self
      (DirectiveTask $task $order $state $agent $rule)
      True))

(= (gc-directive-duplicate-claim $task)
   (match &self
      (DirectiveClaim $task $agent $version)
      (ExistingClaim $agent $version)))

(= (gc-directive-claimable $task)
   (match &self
      (DirectiveTask $task $order ready $agent $rule)
      (match &self
         (DirectiveClaimOpen $task)
         True)))

(= (gc-directive-claim-receipt $task)
   (match &self
      (DirectiveClaim $task $agent $version)
      (ClaimReceipt $task $agent $version)))

(= (gc-directive-next-rows)
   (match &self
      (DirectiveTask $task $order ready $agent $rule)
      (match &self
         (DirectiveClaimOpen $task)
         (DirectiveNextRow $order $task $agent $rule))))

; Memory propositions and lifecycle.
; The host adds these ground facts to a memory space and asks these relations which
; propositions are still visible. A proposition is visible while its own state is active
; and it still has either an active supporting assertion or a proof whose premises are all
; active. Retracting the last support, or a premise of the only proof, hides the
; proposition and every conclusion whose remaining proofs depend on it. Supersession makes
; the old proposition's state superseded, which drops it from every visibility answer.
;
; Constructors the host writes as ground facts:
;   (MemoryProposition <id> <scope> <kind>)
;   (MemoryContent <id> <sentence>)
;   (MemoryTree <id> <sh-tree>)
;   (MemorySource <id> <assertion-id> <source-type> <source-ref>)
;   (MemoryAssertionState <id> <assertion-id> <state>)               active | retracted
;   (MemorySourceTruth <id> <assertion-id> <strength> <confidence>)
;   (MemoryState <id> <state> <revision>)               active | retracted | superseded
;   (MemoryRecordedAt <id> <timestamp>)
;   (MemoryDerivation <derived-id> <rule-id> (<premise-id> ...))
;   (MemorySupersedes <new-id> <old-id>)

(: gc-mem-nonempty (-> Atom Bool))
(: gc-mem-state-active (-> Atom Bool))
(: gc-mem-has-active-assertion (-> Atom Bool))
(: gc-mem-active (-> Atom Bool))
(: gc-mem-active-v (-> Atom Atom Bool))
(: gc-mem-has-valid-proof (-> Atom Atom Bool))
(: gc-mem-proof-valid (-> Atom Atom %Undefined%))
(: gc-mem-all-active (-> Atom Atom Bool))
(: gc-mem-active-proposition (-> %Undefined%))
(: gc-mem-active-in-scope (-> Atom %Undefined%))
(: gc-mem-active-of-kind (-> Atom Atom %Undefined%))

; A collapsed match is nonempty when its result list past the comma marker is not ().
; size-atom over a collapse counts match branches, including the ones a template pruned
; with (empty), so it cannot count surviving results; gc-collapse-tail drops the marker.
(= (gc-mem-nonempty $collapsed) (not (== (gc-collapse-tail $collapsed) ())))

(= (gc-mem-state-active $id)
   (gc-mem-nonempty (collapse (match &self (MemoryState $id active $revision) $revision))))

(= (gc-mem-has-active-assertion $id)
   (gc-mem-nonempty
      (collapse (match &self (MemoryAssertionState $id $assertion active) $assertion))))

; Visibility. The visited set stops a cyclic derivation from looping. and/or are strict
; and demand Bool arguments, so the proof branch runs through a nested if only when no
; active assertion already supports the proposition.
(= (gc-mem-active $id) (gc-mem-active-v $id ()))

(= (gc-mem-active-v $id $seen)
   (if (is-member $id $seen)
       False
       (if (not (gc-mem-state-active $id))
           False
           (if (gc-mem-has-active-assertion $id)
               True
               (gc-mem-has-valid-proof $id (cons-atom $id $seen))))))

(= (gc-mem-has-valid-proof $id $seen)
   (gc-mem-nonempty (collapse (gc-mem-proof-valid $id $seen))))

(= (gc-mem-proof-valid $id $seen)
   (match &self
      (MemoryDerivation $id $rule $premises)
      (if (gc-mem-all-active $premises $seen) valid (empty))))

; foldl-atom deconstructs its list argument directly, so pass the bound premise tuple; a
; noeval wrapper would be deconstructed literally and recur forever.
(= (gc-mem-all-active $premises $seen)
   (foldl-atom $premises True $accumulator $premise
      (and $accumulator (gc-mem-active-v $premise $seen))))

; Active propositions as a nondeterministic stream that downstream rules can consume.
(= (gc-mem-active-proposition)
   (match &self
      (MemoryProposition $id $scope $kind)
      (if (gc-mem-active $id) $id (empty))))

(= (gc-mem-active-in-scope $scope)
   (match &self
      (MemoryProposition $id $scope $kind)
      (if (gc-mem-active $id) $id (empty))))

(= (gc-mem-active-of-kind $scope $kind)
   (match &self
      (MemoryProposition $id $scope $kind)
      (if (gc-mem-active $id) $id (empty))))
