# Vision review and foreman revision

## Current flow

The automatic fallback is **back to the foreman**, not a file restore.

1. If `审图` is enabled, the app captures its current window after a meeting.
2. A multimodal model reviews the screenshot against the brief / acceptance criteria.
3. If the review fails, the issues are sent to the elected foreman with the original brief and decision.
4. The foreman returns:
   - gaps
   - reassigned agents + tasks
   - ordered repair tasks
   - a revised brief for the next round
5. The UI shows a `回退主 Bot · 重新分发` card with a button to start the next meeting from the revised brief.

The owner still decides whether to run the next round.

## Verified backend

`POST /api/vision/review` is real: it sends a local screenshot to Doubao/Qwen and returns pass/score/issues.

`POST /api/revision` is real: it calls the elected foreman model and returns `gaps`, `reassign`, `tasks`, `nextBrief`, `rationale`. The reassign list is filtered to the current selected roster when `agents` is supplied.

A manual UI run with the app icon as a deliberately invalid screenshot produced:

```text
review: pass=false, score=0
status: 已回退主 Bot · 已重新分发
revision card: 2 cards in the result panel
```

## Boundary

- The old directory-snapshot/file-rollback experiment is retired from the product flow. The backend route now returns `410` and tells callers to use `/api/revision`.
- `self-review`/`full` are local policy levels, not a VM. See `docs/SECURITY.md`.
- The vision review does not modify code; it only produces a review and a foreman repair plan.
