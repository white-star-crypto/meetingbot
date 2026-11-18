# Meeting protocol

## Phases

```text
brief
  ↓
independent proposals       (no agent sees another)
  ↓
anonymize P1..Pn
  ↓
peer vote                   (scores + ranking)
  ↓
elected foreman
  ↓
foreman decision            (adopt / veto / merge)
  ↓
owner gate                  (no code is written in v0)
```

## Why proposals are independent

Shared context before the first proposal creates anchoring. Every agent would
start from the same framing and converge too early. The first round is a
diversity round, not a consensus round.

## Why voting is anonymized

If voters know that P2 came from a famous model, they may vote for the brand,
not the proposal. The anonymized IDs force the vote to be about the artifact.

`proposals/_index.json` preserves the mapping after the meeting for audit.

## Foreman powers

The elected foreman can:

- adopt proposals
- veto a proposal for a hard reason
- merge parts of proposals

Allowed veto categories:

```text
safety        harmful or unsafe
scope         outside the brief / MVP
budget        exceeds token, time, or implementation budget
infeasible    cannot be built under the constraints
conflict      conflicts with a higher-priority requirement
```

Not allowed:

```text
aesthetic     "I do not like the look"
model         "that model is weak"
vague         no reason
```

Aesthetic disagreement must appear in `merge_plan` so minority ideas are not
lost. A veto requires a reason and is stored in `decision.json`.

## Vote aggregation

v0 uses:

- average score across all voters
- number of first-place rankings as tie-breaker
- stable proposal ID as final tie-breaker

This is intentionally simple. Later versions can add:

- self-vote discount
- confidence weighting
- Condorcet / ranked pairs
- owner override

## Owner gate

The meeting never writes code, executes tools, or changes a repository.

After the decision:

1. owner reads `decision.md`
2. owner approves, edits, or re-runs with a narrower brief
3. a separate build stage can be started

## Next stages (not in v0)

- builder agents in isolated worktrees
- test runner and diff review
- multimodal review of screenshots/recordings
- final owner approval
