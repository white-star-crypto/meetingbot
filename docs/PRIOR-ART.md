# Prior art and what to borrow

Research date: 2026-11-07

## 1. AI Design Review Board

https://github.com/Debashish-Mukherjee/ai-design-review-board

Closest functional match found:

- a panel of 8 specialized reviewers + a Referee
- parallel agent execution
- optional multi-round debate with consensus detection
- real-time SSE streaming
- structured JSON responses
- debate replay / convergence visualization
- knowledge base + RAG
- Streamlit UI

What we should borrow:

1. **SSE live progress** instead of the current demo playback.
2. **Consensus / convergence view** after debate rounds.
3. **Debate replay** from saved runs.
4. **Knowledge base slot** for house design rules.
5. **Referee is not the same as our foreman**: keep our anonymous multi-model vote,
   but add a referee summary block for readability.

What not to copy:

- Streamlit's UI and Python process model.
- Role-only reviewers; our differentiator is heterogeneous models, not eight prompts on one model.
- Azure-specific integration.

## 2. AI Council

https://github.com/hereisSwapnil/ai-council

- Council Head manages rounds and synthesizes a decision.
- Members are different LLMs.
- Collapsible responses and round-by-round view.
- OpenRouter/Ollama model selection.

What we should borrow:

1. **Collapsible member responses** (already started).
2. **Round timeline** with visible phase boundaries.
3. **Council Head summary** distinct from individual votes.

Our difference: anonymous proposals + bounded foreman veto + explicit
architecture/aesthetics/security scoring.

## 3. T3 Code / Open WebUI appearance & settings

- T3 Code: https://github.com/pingdotgg/t3code
- Open WebUI theme ecosystem: https://openwebui.com/

What we should borrow:

1. Theme presets: system / light / dark, with a small accent token set.
2. Typography and density settings, not dozens of colors.
3. Plugin/theme marketplace with a manifest, preview and permissions.
4. Settings grouped by intent (appearance / behavior / data), not a wall of toggles.

What not to copy:

- Full theme-engine complexity before the core workflow works.
- Copying DSH plugin installers directly; their host API and permissions differ.

## 2. Multi-mode / group-chat prior art (2026-11-09)

This pass compared the five-mode workbench against the closest open-source
projects. Star counts are approximate and move; links are the source of truth.

| Project | What it proves | What to borrow | What not to copy |
|---|---|---|---|
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | independent answers → anonymized peer review → chairman synthesis is understandable without a dashboard | stage inspector, anonymous labels, ranking matrix, visible final synthesis | single-mode council page; we keep a reusable roster and decision artifact |
| [richard1208/parallio](https://github.com/richard1208/parallio) | multi-model desktop group chat with an extension and local artifacts | @-mention autocomplete, participant/role strip, material tray, per-model context/cost | group chat as the only mode; browser-extension scope |
| [EKKOLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio) | one agent catalog can drive chat, group and workflows | capability badges, provider health/test, one catalog for all pickers | platform/workflow-builder scope before the meeting workflow is stable |
| [ai-shifu/ChatALL](https://github.com/ai-shifu/ChatALL) | parallel columns are a product, not a debug view | per-column status/retry/copy, synchronized scroll, cost/token display, diff view | columns without a merge or saved artifact |
| [a1exsun/dsh-council](https://github.com/a1exsun/dsh-council) | anonymous reviews make council output inspectable | review cards, explicit reasons, final-decision audit | a second isolated council UI disconnected from our roster/session store |
| [fqxxzyw/dsh-groupchat](https://dshfind.com/zh/plugins/fqxxzyw/dsh-groupchat) | multi-role independent sessions, @ across groups, member memory, approval | @ completion, role chips, scoped memory, approval cards | cross-group complexity and a separate IM-like universe |
| [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | bounded DAGs + Run Center + per-agent model/tools + token insights | unified Run Center, per-step retry, token/cost visibility | node-graph builder complexity for a meeting-centric app |
| [AgentPulse](https://www.producthunt.com/products/agentpulse-3) | company-style roles, owner approval and a process trail | owner gate, run timeline, explicit "who is doing what" | "hire AI employees" metaphor and heavyweight org UI |

### Borrow list, ranked

1. **Compare controls** (ChatALL): single-column retry/copy, usage/cost,
   synchronized scroll, difference view, pin-to-merge.
2. **Council inspector** (llm-council / dsh-council): raw proposals, anonymized
   peer rankings, final synthesis, reasons and audit trail in one place.
3. **Run Center** (dsh-agent-team-gui): one timeline for meeting/division/compare
   runs with model, tokens, duration, status and retry.
4. **Group affordances** (parallio / dsh-groupchat): @-mention autocomplete,
   role chips, material tray, scoped member memory.
5. **Agent catalog** (Ekko): capability/health/cost metadata on the shared roster.

Deliberately deferred: visual DAG builder, cross-group memory, plugin marketplace
expansion, platform/agent-hosting features.

## Conclusion

MeetingBot is not a clone of any one project. The closest prior art is
AI Design Review Board, but it is role-based, Python/Streamlit, and centered on
architecture review. Our wedge is:

> heterogeneous model identities + anonymous proposals + bounded foreman +
> aesthetic dimension + a portable decision artifact.

Borrow the proven interaction patterns, not the whole architecture.
