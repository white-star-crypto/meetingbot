# DSH plugin adapter — decision

## Verdict

Worth doing, but **not as the core**.

MeetingBot should stay a standalone Node CLI/API. A DSH plugin should be a
**thin adapter** around it, not a rewrite of the meeting engine.

## Why not make DSH the core

- DSH plugin APIs can change; the meeting protocol should not.
- Users may run MeetingBot outside DSH.
- A plugin crash should not take down the meeting artifacts.
- The core must remain testable without a host.

## What the adapter should expose

1. **Run meeting** — choose a preset, write a brief, receive the run path.
2. **Presets** — list/select presets like `DeepSeek + MiMo` or
   `Qwen + MiMo + Wenxin`.
3. **Single-bot review** — for a plugin/feature that does not fit the council,
   send it to one model with a compatibility rubric and get a short verdict.
4. **Run list / read decision** — return `decision.md`, `report.html`, and
   `tally-audit.json`.
5. **Provider management** — add/list/test OpenAI-compatible endpoints.

## Single-bot fallback

If a plugin cannot be adapted cleanly:

```text
plugin source / manifest
  → one model
  → compatibility report:
      what the plugin does
      where it conflicts with MeetingBot
      what to change
      effort estimate
  → user chooses:
      let that bot modify it
      or send the proposal to the council
```

This is a good fallback, not the main workflow. It should be explicitly labeled
as a **single-reviewer opinion**, not a council decision.

## Sequencing

1. Freeze standalone CLI/API and presets.
2. Add a `plugin-api.mjs` adapter contract.
3. Build the DSH plugin against that contract.
4. Add single-bot review.
5. Test cold boot + uninstall + failure isolation.

## Non-goals for now

- No unrestricted filesystem/shell access for external models.
- No auto-install of third-party plugins.
- No silent code changes.
