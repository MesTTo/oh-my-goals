% Map generic policy outcomes to task lifecycle states.
gc_task_state(forbidden, blocked).
gc_task_state(conflict, blocked).
gc_task_state(obligated, ready).
gc_task_state(permitted, backlog).
gc_task_state(unregulated, backlog).
