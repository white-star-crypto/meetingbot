# Why this exists

Most multi-agent coding projects optimize for **one** of these:

- role-play a software company
- split a task into subtasks
- have a manager delegate
- generate code in parallel

This project optimizes for a different question:

> Can a group of different models make a better *decision* before anyone writes code?

The meeting is the product. Code generation is a later stage.

## The bet

A complete brief plus diverse proposals plus a hard decision gate can reduce
downstream rework. The meeting costs more tokens up front, but if it prevents a
wrong architecture or a weak visual direction, it pays for itself.

This is a hypothesis, not a proven law. The v0 exists to measure it.

## What makes it different

1. **Different models, not different roles on one model.**  
   A weaker model can still contribute a useful aesthetic idea.

2. **Anonymized proposals.**  
   Votes are about the proposal, not the provider.

3. **A foreman with a bounded veto.**  
   The foreman can stop a bad direction, but cannot erase aesthetic dissent.

4. **Aesthetic is a first-class field.**  
   Every proposal has architecture and aesthetic sections.

5. **Multimodal review is planned as a separate gate.**  
   Text review cannot catch a layout that looks wrong.
