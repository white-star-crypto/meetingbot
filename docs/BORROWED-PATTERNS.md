# Borrowed patterns and our own line

We looked at how existing multi-agent products organize the same problem, and borrowed only workflow/interface patterns, not visual identity or copy.

## What we borrowed

- **AutoGen Studio**: a team/agent builder, run history, and a clear distinction between configuration and execution. We keep the separation; our own addition is the Condorcet/foreman decision contract.
- **CrewAI Crew Studio**: visible team composition and role assignment. We borrow the “who is on this run” visibility, not the dashboard.
- **LangGraph Studio**: step-by-step run inspection and resumable state. We are adding stage status and a decision page; we do not copy the graph editor.
- **Dify**: provider/model configuration separated from the work surface. We use a compact model picker and a single roster source.
- **ChatDev / MetaGPT**: role division (product/architect/engineer/reviewer). This informs the division mode prototype.
- **RouteLLM**: capability-based routing from preference data. This is the basis for the on-demand mode; it is not a universal “best model” ranking.
- **Mixture-of-Agents**: several model outputs aggregated; our difference is an explicit decision artifact with adopt/reject/risk/next-step fields.

## What we deliberately do not copy

- no infinite canvas/graph editor;
- no marketplace-first home;
- no token/cost dashboard as the main screen;
- no fake “agents are working” animation without real state;
- no universal leaderboard shown to users.

## Our line

Meeting-first, not canvas-first.

The product’s identity is a **decision artifact**, not a chat feed and not an agent graph.
