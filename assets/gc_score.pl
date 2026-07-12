% GoalChainer score and decision relations.

gc_score(forbidden, _, _, _, Score) :- !, Score = -1.0.
gc_score(conflict,  _, _, _, Score) :- !, Score = -1.0.
gc_score(Deontic, Strength, Confidence, Motivation, Score) :-
    ( Deontic == obligated -> Bonus = 0.1 ; Bonus = 0.0 ),
    Evidence is Strength * Confidence,
    Score is 0.54 * Motivation + 0.38 * Evidence + Bonus.

gc_decision_status(forbidden, _, _, blocked) :- !.
gc_decision_status(conflict,  _, _, blocked) :- !.
gc_decision_status(_, Score, 0, recommended) :- Score >= 0.72, !.
gc_decision_status(_, Score, _, candidate) :- Score >= 0.5, !.
gc_decision_status(_, _, _, weak).

gc_decide(Deontic, Strength, Confidence, Motivation, HasMissing, [Score, Status]) :-
    gc_score(Deontic, Strength, Confidence, Motivation, Score),
    gc_decision_status(Deontic, Score, HasMissing, Status).
