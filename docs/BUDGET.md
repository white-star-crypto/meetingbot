# Automatic budget strategy

## Why fixed budgets fail

A fixed `max_tokens` is not a budget for the task. It is only a ceiling on one model response. Long SVG or long code tasks fail because:

- the model spends completion tokens on reasoning;
- the provider has its own lower output cap;
- a truncated response cannot be repaired by simply "asking again with more time";
- 7 models x one large call does not equal a better artifact.

## Proposed policy

1. **Classify the task before calling any model**
   - visual / code / review / chat
   - input chars, source snapshot size, model count
2. **Reserve a small plan stage**
   - 4k–12k tokens normally
   - ask for a short plan, not the final artifact
3. **Generate the artifact in sections**
   - skeleton → scene/module A → B → C → final assembly
   - each section has a hard output budget and a validator
4. **Escalate only the failed stage**
   - inspect `finish_reason` and JSON/SVG validity
   - if `length` or truncated, multiply that stage by 1.6, cap at 50k
   - never rerun all seven sub-agents because the main Bot truncated
5. **Hard budget gate**
   - default small task: sub 10k, main 20k
   - medium: sub 20k, main 30k
   - large code/visual: sub 40k, main 50k+ only after chunking
   - stop when the artifact validates; unused budget is not a goal
6. **Record actual usage**
   - prompt, completion, reasoning, finish reason, invalid output
   - compare against estimate; revise the estimator with real data

The prototype implementation is `src/budget-planner.mjs`.

## Current integration

`src/meeting.mjs` now calls `estimateTask()` at the start of a meeting:

- proposal / critique / vote use the planner's `planTokens`;
- the foreman decision uses `mainTokens`;
- an empty or length-truncated response retries once with 1.6x the stage budget, capped at 50k;
- the chosen budget is written to `meta.json`.

This is automatic for `runMeeting()`. Custom scripts (for example the ad-hoc pelican or review scripts) still choose their own budgets; they are not the product path.

## Non-negotiable

More tokens do not fix a provider's hard output cap. Long artifacts must be chunked and validated, not generated in one heroic call.
