# 合议 MeetingBot

多模型 AI 会议：多个模型独立提案、匿名互评、投票，最后由主 Bot 汇总成一份可执行的决定。Windows 本地优先，源码公开。

> **协议：MeetingBot Community License 1.0.0**
> 允许个人、企业、团队使用，包含商业项目、客户交付和二次创作；**禁止倒卖软件/源码、轻微修改后重新打包出售，或作为竞品托管服务**。使用平台创作的内容归使用者。不是 OSI 开源协议。详见 [LICENSE](LICENSE) 和 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

## 中文简介

合议不是让一个模型直接给答案。它让多个模型先各自独立提案，再匿名交叉评审、多维投票，选出主 Bot 汇总；主 Bot 可以采纳、基于硬性理由否决，或合并少数派方案。

适合：方案讨论、架构评审、代码/设计评审、决策对比。

- **合议协作**：所有选中模型参与提案、评审、投票
- **分工制**：按推理、代码、视觉、写作等领域分工
- **按需点将**：根据任务选出主模型和评审模型
- **群聊讨论**：轻量多角色讨论，可转成正式合议

本版 `1.0.0` 未签名，也没有自动更新；这是干净的 portable 版本。

## 下载与安装

- [GitHub Releases](https://github.com/white-star-crypto/meetingbot/releases/tag/v1.0.0)
- [Gitee Releases](https://gitee.com/uchiha-li-ga/meetingbot/releases/tag/v1.0.0)

Windows：下载 portable zip，解压后双击 `合议.exe`。未签名版本可能触发 SmartScreen，选择「更多信息 → 仍要运行」。应用不内置 API Key，需要自己配置模型服务。

校验下载文件：[SHA256SUMS.txt](https://github.com/white-star-crypto/meetingbot/releases/tag/v1.0.0)。

---

## English

[github.com/white-star-crypto/meetingbot](https://github.com/white-star-crypto/meetingbot)

Multi-model design meeting for software work.

> V1 release candidate: **1.0.0**, **unsigned** (code signing and auto-update are pending). Verify downloads with `SHA256SUMS.txt`; an unsigned build may show an unknown-publisher warning.

> Multiple models propose independently → proposals are anonymized → peers vote → one foreman is elected → the foreman can adopt, veto for hard reasons, or merge. A human approves before any code exists.

This is a meeting, review, and optional local-tool Agent app. The meeting core does not execute code or modify a repository. Agent tools and build-gate are opt-in, permission-gated, and read-only by default.

This build adds three work modes, one roster source of truth, multimodal review with foreman re-dispatch, a DSH plugin market, a tool-using Agent with four permission levels, context compression, owner interjection during live meetings, and per-model live status (running / done / failed) on the meeting progress card.

See [CHANGELOG.md](CHANGELOG.md) for the current release and verification notes.

## Why this exists

A single agent often commits to the first plausible architecture or visual direction.

This workflow spends tokens before code to expose:

- different interpretations of the same brief
- different architecture tradeoffs
- different aesthetic directions
- risks that one model would miss

A weaker model can still contribute the best aesthetic idea.

## Workflow

```text
brief
  ↓
each selected model proposes independently
  ↓
anonymize as P1..Pn
  ↓
cross-debate: critique architecture / aesthetics / security
  ↓
compressed debate digest (no full history replay)
  ↓
each model casts an argument-based multi-dimensional vote
  ↓
elect foreman (weighted overall + first-place tie-break)
  ↓
foreman: adopt / veto / merge / rejection strengths / risks / code structure
  ↓
owner gate
```

Foreman veto is only valid for:

```text
safety        scope        budget
infeasible    conflict
```

Aesthetic disagreement is **not** a veto. It goes into `merge_plan` so minority ideas survive.

## Owner interjection during a live meeting

While a meeting is running, the owner can send messages from the composer
(`POST /api/meetings/:id/interject`, capped at 20 messages × 2000 characters).
Each interjection is queued on the live run and injected as an authoritative
constraint into the prompts of the phases built **after** it arrives — critique,
vote, and decision (a phase whose model calls are already in flight cannot be
changed retroactively, and the UI says "接下来的阶段" rather than promising all
three). The run records them in `meta.json`, `transcript.jsonl` (lazily, on
first real injection), and the decision card
(`N 条已纳入本轮（批判 / 投票 / 决策）`). If the meeting has already ended the
endpoint answers `409` and the panel says the message did not enter any round
instead of pretending it was delivered.

## Work modes (independent workspace entries)

Sidebar names: **合议** (council), **分工** (division), **点将** (on-demand).

| Mode | Who runs | What is real |
|---|---|---|
| 合议协作 `council` | every selected model | proposals, critiques, votes, Condorcet, foreman |
| 分工制 `division` | one owner per capability domain | `reasoning / code / visual / writing` assignments are chosen from the selected roster; the rest review |
| 按需分配 `ondemand` | task-domain winner + reviewer | domain is classified from the brief, the best-fit model is primary, the next is reviewer/fallback |

Routing is written into `meta.json` / `decision.json` as `workMode`, `routing.assignments`, `routing.primary`, `routing.reviewer`, and `roles`.

## One roster source of truth

`state/roster.json` owns the user's selected models, reasoning levels, presets, pinned models/presets, name, and work mode. The panel reads and writes it through `GET/PATCH /api/roster`; a meeting reads the same store, so the default roster is not duplicated in local JS, presets, and the meeting config.

The canonical seven-model lineup is:

```text
DeepSeek V4.1 Flash · GLM-5.3 Flash · MiMo V2.6 Flash · Qwen3.8 Flash
ERNIE 5.1 · Doubao Seed 2.1 Turbo · MiniMax M3.1 Flash
```

## Group chat (light layer)

A separate group-chat workspace sits beside the formal meeting:

- create a group from one sentence; the planner picks up to three canonical roster members;
- every member can carry a persona (job / responsibility / boundary);
- `ondemand` replies through the most relevant member, `free` caps the round at two,
  and `@member` forces a specific speaker;
- groups persist in `state/groups.json`; they are not votes and cannot change
  `decision.json` or `canBuild`;
- **转正式合议** builds a brief from the transcript and opens the normal meeting
  composer. The formal meeting still runs anonymous proposals, critique,
  Condorcet and the decision gate.

Endpoints: `GET/POST /api/groups`, `POST /api/groups/plan`,
`GET/DELETE /api/groups/:id`, `POST /api/groups/:id/messages`,
`POST /api/groups/:id/convert`.

## Multimodal review → foreman revision

`POST /api/vision/review` asks a vision model for structured acceptance JSON.

`POST /api/revision` sends a failed review back to the elected foreman. The foreman returns:

```text
gaps → reassigned agents/tasks → ordered repair tasks → nextBrief
```

The UI shows a `回退主 Bot · 重新分发` card and a button to start the next round from `nextBrief`. It does **not** restore files or roll back a directory.

Electron captures the real window through `window.meetingbot.captureWindow()`. The panel has a `多模态验收 / 回退主 Bot` entry, and the `审图` checkbox adds a real review card + revision card to the decision page after a live meeting.

## Context

Private chat keeps a local message history with a token budget. When the budget is exceeded:

- `压缩` summarizes older turns and keeps working context.
- `缓存摘要` compresses earlier.
- `仅当前` sends only the current turn.

The composer shows a real `上下文 N` chip; compression calls `POST /api/context/compress` (model-backed) and keeps the summary in the next Agent prompt.

## DSH plugin market

The plugin page is built from the actual `dsh-plugin-catalog` npm package (9,412 entries at the time of this build), served from `public/dsh-plugins.json`. The catalog (8.5 MB) is prefetched during idle time after startup, so the first visit to the plugin page renders instantly; concurrent loads share a single fetch.

**Refreshing the catalog:** the bundled copy is always the offline fallback. The plugin market has a manual **刷新目录** button; it fetches the catalog over HTTPS, validates the shape and size, records its SHA-256, writes the cache atomically and keeps the last good copy if anything fails. It never changes official plugin code and never installs or executes third-party plugins. See [docs/PLUGIN-CATALOG.md](docs/PLUGIN-CATALOG.md) for the update contract and rollout notes.

> **Third-party plugin disclaimer:** the catalog is community-maintained. Listing is not an audit, endorsement, or security guarantee. MeetingBot does not install or execute plugin code. Review source, permissions, dependencies, and licenses before installing/running anything; the installer/operator assumes the risk. MeetingBot and its contributors accept no liability for data loss, credential exposure, system damage, or other harm caused by third-party plugins.

Each card has the description, owner/category/stars, install command, repo link, and **发送给 Agent**. The latter only prefills the private chat input with a plugin-analysis prompt; it does not send. The user reviews/edits and clicks send. The Agent then investigates the plugin and returns an adaptation verdict; the user can choose `发给群修` or `私聊继续`.

The default Agent for this flow is configured in settings (`默认 Agent`); the private chat can still switch models independently.

## Built-in capabilities for the Agent

Tools are not a separate user-facing workspace. The private/plugin Agent uses them through a model-driven loop:

```text
plan → call tool → observe → ask_user if needed → call tool → finish
```

Tools: `ask_user`, `fs.list`, `fs.read`, `fs.write`, `fs.mkdir`, `python.run`, `browser.open`, `browser.read`, `finish`.

- Browser links produced by the Agent open a real in-app `<webview>` overlay.
- File paths produced by the Agent open an in-app text viewer overlay.
- Python runs as a real local subprocess with timeout/output limits.
- The Agent's tool trace is shown under the answer, with clickable file/URL links.

## Permission modes (backend-enforced)

| Mode | Reads | Writes | Python | Disclaimer |
|---|---|---|---|---|
| 只读 `read-only` | any | no | no | no |
| 工作区 `workspace` | any | workspace only | no | no |
| 自审 `self-review` | any | any, with backup | yes | **required** |
| 完全权限 `full` | any | any, no auto-backup | yes | **required** |

The two high-risk modes cannot be enabled through the API without `acceptDisclaimer: true`. The UI requires checking the disclaimer box first.

Basic safety is enforced in code, not just in prompts:

- default is `read-only`
- paths are canonicalized with `realpath`; junctions/symlinks cannot escape the workspace in `workspace` mode
- `state/permissions.json`, `state/roster.json`, and `state/audit.jsonl` cannot be rewritten through tools
- deletes require `confirm:true`; Agent tool calls cannot confirm a delete
- `self-review` backs up files before overwrite/delete
- Python is disabled in `read-only` and `workspace`. `self-review` applies best-effort restrictions (network/process/outside-write denial); `full` is explicitly unrestricted. Neither is an OS sandbox.
- agent browser reads block localhost/private/link-local hosts
- provider-test only accepts public http(s) endpoints; a local mock provider (`localhost`/private IP) is intentionally rejected by this button, even if configured in a participant baseUrl. Use a real public endpoint for the connection test.
- every tool call is appended to `state/audit.jsonl`

## Quick start (no API key needed)

```bash
npm test
npm run demo
```

Output:

```text
runs/<timestamp>/
  brief.md
  roster.json
  proposals/P1.json ...
  proposals/_index.json
  votes.json
  decision.json
  decision.md
  report.html
  tally-audit.json
  meta.json
  transcript.jsonl
```

### Data directory

Writable runtime data (`state/`, `feedback/`, `runs/` defaults, caches, backups and
export keys) lives under `MEETINGBOT_DATA_DIR` when set, otherwise under the
current working directory. Packaged Electron builds set this automatically to
Electron's `userData` directory before starting the panel, so installing under
`Program Files` does not require write access to the install directory.

Replay the pure tally on an old run:

```bash
node bin/meetingbot.mjs replay runs/<timestamp>
```

`tally-audit.json` contains the pairwise matrix, self-vote transfers,
Condorcet winner, cycle flag, dimension weights, and the final method.
Replay compares its winner with the saved audit winner and exits 1 with a red
`MISMATCH` if they differ.

`decision.md` starts with a small YAML front-matter (`winner`, `foreman`,
`failover`, `ownerGate`, `canBuild`, `gateStatus`, `mockRun`, `parentRunId`) so
scripts do not need to parse `decision.json`.

Open `report.html` for a self-contained visual report.

## Mock timing and scale

For demos, UI tests, and large-vote checks:

```bash
node bin/meetingbot.mjs start --brief examples/brief.md \
  --config examples/config.mock.json --mock --mock-slow 0.3 --mock-size 12
```

`--mock-slow` is seconds per fake stage step (capped at 5s); `--mock-size`
creates 1-200 proposals so the progress rail and tally can be exercised at
scale. Mock runs never hit the stage cache.

## Follow-up meetings

A finished decision card has **基于此轮再开一轮**. It calls
`POST /api/meetings/followup-brief`, which reads the parent `decision.json` and
`brief.md`, builds a new brief with the previous merge plan / build tasks /
risks, then records `parentRunId` on the new run and in the new decision
front-matter. The previous decision is treated as evidence, not as an order.

## Decision execution approval

The decision page no longer sends free-form decision text to the executor. A human must first
approve a concrete task scope:

- `GET /api/decisions/approval?runDir=...` returns the current approval and selectable tasks.
- `POST /api/decisions/approval` stores a task list plus a SHA-256 fingerprint of the exact
  `decision.json` that was approved.
- `POST /api/decisions/approval/revoke` revokes the current approval.
- `POST /api/executor/run` requires `runDir` + `approvalId`; it re-reads the decision, validates it
  against the decision schema, checks the fingerprint, rebuilds the task from the approved scope,
  and then runs the Agent.

Any change to `decision.json` makes the old approval stale. The same approval may be retried for
the same exact scope; revocation stops any future execution. An approval also expires after 24
hours, so an old approval cannot be used indefinitely. It does not interrupt an Agent that is
already running. Approval scope is separate from Agent file permissions. The approval store lives
at `state/decision-approvals.json` and is protected from normal file tools.

## Usage center

Run Center also shows local token usage, derived from each run's `transcript.jsonl`
(with `meta.json` totals as a fallback for older runs):

- total input / output / cached / reasoning tokens, run count and call count;
- a per-Agent breakdown with call count, input and output;
- a per-phase breakdown (proposal / critique / vote / decision);
- today, 7-day, 30-day and all-time ranges;
- a 14-day token trend and per-run input/output in the run list.

`GET /api/usage?days=1|7|30|0` returns the same aggregate. Reasoning tokens are
reported inside output tokens; cached tokens are reported inside input tokens,
so neither is added twice to the total. The view shows token counts only — it
does not guess prices or scrape vendor quota pages.

The run stage dialog also shows a per-call timeline derived from
`transcript.jsonl`: phase, Agent, elapsed milliseconds, tokens and any call
error. This makes it possible to see where a meeting spent its time and tokens.

## Durable runs

An interrupted run can be resumed from its existing artifacts instead of starting over:

- proposals already written to `proposals/*.json` are reused;
- an existing `critiques.json` is reused;
- if voting finished but the decision did not, the decision is repaired from the stored votes;
- usage totals and `createdAt` from the original run are preserved;
- the run directory stays the same; completed phases are not called again.

Endpoints:

```text
POST /api/runs/:id/resume
GET  /api/meetings/:resumeId
```

`POST /api/runs/:id/resume` returns `409 RUN_COMPLETE` when `decision.json`
already exists. The resume is phase-level, not a per-token crash-recovery
system: if the process dies in the middle of a model request, that request is
retried; completed phase artifacts are the durable boundary.

A running meeting can also be cancelled:

```text
POST /api/meetings/:id/cancel
```

Cancellation is checked between phases. The current model call is allowed to
finish; the UI says “当前模型调用结束后生效” instead of pretending to abort an
HTTP request that is already in flight.

## Stage cache

Successful proposal / critique / vote / decision calls are cached under
`state/cache` by default (`cache.enabled`, `cache.ttlDays`, `cache.dir`).
Keys include brief/prompt text, phase, participant id/model/baseUrl, and token
limits, so changing the prompt or model invalidates the entry. Cache hits
return `usage: null` and never bill fake tokens; use `--no-cache` for a clean
measurement. Cache writes are best-effort and never fail a meeting.
This is a **sampling cache**: an identical brief/prompt/model call reuses the
previous output, so it is not a fresh independent sample. Use `--no-cache`
when you need new proposals or are measuring model variance.

## Multimodal briefs

A brief may reference local images with Markdown:

```markdown
![current screen](images/current.png)
```

Images are read only from the brief directory / app workspace, max 4 images,
12MB each, png/jpg/jpeg/webp/gif. Models tagged `multimodal` receive standard
OpenAI-style `image_url` content; other models receive a text note and are
told not to guess image contents. Only the proposal phase sees images; the
critique and vote phases remain text-only, so visual claims must be material
in the proposal text.

## PR review brief

Generate a review brief from a git diff, then run a normal meeting on it:

```bash
node bin/meetingbot.mjs pr-review --repo . --base main --head HEAD \
  --out pr-review-brief.md
node bin/meetingbot.mjs start --brief pr-review-brief.md --config meeting.config.json
```

This is local-only; it calls `git diff`, does not fetch a PR or call a model.

## CI / script output

`start`, `gate`, and `validate` accept `--json`; the whole stdout is one JSON
object, and failures are emitted as `meetingbot/cli/error/v1`. `--json` never
includes API keys.

```bash
node bin/meetingbot.mjs validate --config meeting.config.json --json
node bin/meetingbot.mjs start --brief brief.md --config meeting.config.json --json
```

## Optional MCP servers

MCP is off by default. Enable it explicitly in `mcp.enabled` and whitelist
servers under `mcp.servers`; read-only mode only exposes servers marked
`readOnly: true`. This repo does not install or launch Windows-MCP by default;
see [docs/MCP.md](docs/MCP.md) for the integration shape and security boundary.
MCP tools do **not** go through the fs/path permission allowlist; their safety
boundary is explicit server config + `readOnly` + the current permission mode.
Treat a non-`readOnly` server as granting its own process-level access.

## Repair a failed foreman decision

If the final decision call times out, do not rerun the whole meeting:

```bash
node bin/meetingbot.mjs repair runs/<timestamp> --timeout-ms 600000
```

This reuses proposals, critiques, votes, and tally; it only calls the elected
foreman again and rewrites `decision.md` / `report.html`.

## Support

V1 does not ship a donation/support entry. The previous voluntary-support link is intentionally
disabled until there is enough usage to justify reopening it. Donations never unlock or lock any
feature.

## Feedback

The product only accepts feedback; it does not expose a feedback inbox. Entries are appended to
`feedback/feedback.jsonl` and are never uploaded. Users and agents can submit through the normal
feedback form or `POST /api/feedback` (`source: "agent"`); no contact details are collected.

The inbox is a separate owner-only local tool, not a product view and not an HTTP endpoint:

```bash
node scripts/feedback-inbox.mjs          # terminal view
node scripts/feedback-inbox.mjs --json   # machine-readable
node scripts/feedback-inbox.mjs --html --open
```

Run it only on the machine that owns `feedback/feedback.jsonl`. There is deliberately no
`GET /api/feedback` route, so other users of the app cannot read submitted feedback.

## Account-scoped local data

Cloud sync only covers preferences. Sessions and memory stay local and are scoped by account:

```text
state/accounts/<account-id>/sessions.json
state/accounts/<account-id>/memory.json
state/accounts/guest/...
```

On first upgrade, existing `state/sessions.json` and `state/memory.json` are copied once into the
signed-in account's scope. Signing out switches to the `guest` scope, so it cannot show the previous
account's conversations. Data is not uploaded by this feature.

## Single-agent mode

```bash
node bin/meetingbot.mjs ask \
  --config meeting.config.local.json \
  --agent mimo \
  --prompt "用一句话说明什么是只读数据契约。"
```

This is the direct one-agent path; it does not create a meeting or participate
in a vote.

See [docs/APP-SHELL.md](docs/APP-SHELL.md) for the Electron standalone-window plan.

## Prior art

See [docs/PRIOR-ART.md](docs/PRIOR-ART.md): AI Design Review Board, AI Council,
T3 Code/Open WebUI themes, and what to borrow without copying.

## Run the desktop app

On Windows, double-click `MeetingBot.cmd` (or `MeetingBot.lnk`). It starts the
native Electron window and the local panel server automatically.

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-app.ps1
```

The native window was verified on Windows 10 with Electron **36.9.5**. Electron 45
crashed on this machine, so the devDependency is pinned to the 36 line.

If `node_modules/electron` is missing, the launcher falls back to a chromeless
Edge app window so the panel is still usable. Before reusing an already-running
panel server on the fallback port, the launcher checks that the served version
matches this build, and refuses (naming the process id) when an older panel is
holding the port.

## Portable app

The portable build is `dist/MeetingBot-portable-20261107/`:

- includes Electron 36.9.5
- no `npm install` needed
- double-click `MeetingBot.cmd` or `MeetingBot.lnk`
- `MeetingBot-portable-20261107.zip` is the copyable archive

The source checkout still needs `npm install` before `MeetingBot.cmd` uses
Electron; if Electron is absent it falls back to the chromeless Edge window.

## Electron app shell

```bash
npm install
npm run app
```

The Electron main process is loaded directly (`electron electron/main.cjs`) on
purpose: the package-entry `.` path crashed in this environment while direct
main loading worked. The same main starts the local panel server on a random
localhost port, opens a native window, and loads the panel.

This is the development shell; an installer/signing pipeline is the next step.

## Panel

```bash
node bin/meetingbot.mjs panel --config meeting.config.local.json --port 4318
```

Open `http://127.0.0.1:4318`, or use `npm run app` for the Electron shell. The panel
is the real UI, not a mock:

- 「发起会议」calls `POST /api/meetings/start` and polls the run until a real
  decision (`decision.md` / `report.html` / `meta.json`) is produced; 「示例演示」
  is clearly labelled as sample data and never claims to be a real meeting
- while a meeting runs, the feed shows a live progress card (phase stepper with
  per-model counters like `独立提案 1/2`, elapsed time, roster, interjection
  count — all reported by the meeting engine through `onProgress` and the
  polling endpoint); 「放弃等待」 stops *waiting* without pretending to cancel
  the run, and a meeting that finishes in the background is still recorded in
  the session list and reachable from the 「决策书」 button. If that background
  run fails, a short Chinese notice names the failing stage and model (taken
  from the engine's real error) and offers 「重试本次任务」 / 「换模型再试」;
  the raw internal message is kept as secondary "技术细节" text
- independent proposals, cross-critique, Condorcet vote, and the foreman decision
  are rendered from the run result, including per-model failures and token usage
- a failed run names the phase, the failing model, and the roster, with retry,
  change-model, and copy-error actions
- three work modes (合议 / 分工 / 点将), single-agent private chat, tool calls,
  four permission modes, DSH plugin market, context compression, and the
  vision-review → foreman re-dispatch loop are all reachable from the sidebar
- sessions are remembered and restored. A single session is first moved to an
  archive (recoverable); "彻底删除" on an archived session, or the batch
  "彻底删除" after an explicit confirmation, removes the record from the local
  session file for good — the copy says so and there is no undo in the UI.
  The session file is written atomically (temp file + rename) and re-read
  before every write, so a second panel process or window can no longer
  overwrite the sessions of the first one. A `.json.bak` copy is kept and used
  automatically if the main file is ever truncated.
- notes typed into the meeting composer **before** a meeting starts are not
  dropped: they are shown as "补充约束" chips and merged into the brief that is
  sent to the models. Notes typed while a meeting runs go to the live
  interjection queue, which reaches the critique / vote / decision prompts.
- settings are grouped into six searchable sections. Every item states its
  default value, what it does, and when it takes effect, and can be reset on its
  own. Theme, font scale, density, sidebar width, code font, motion, tool gates,
  agent step limits, run directory and export format all take real effect;
  appearance and tool switches live in browser localStorage, while permissions,
  roster, sessions, audit log and API keys are persisted on disk by the server.
  "导出设置" writes the settings **and the roster** (selected models, reasoning
  levels, pinned models and presets); API keys are never included.
- housekeeping is explicit: "归档保留" removes archived sessions older than the
  chosen number of days (`state/policy.json` keeps the rule across restarts),
  "清空缓存" deletes only review screenshots and snapshots, and "恢复默认权限"
  switches the agent back to read-only without touching any file.
- adding a custom OpenAI-compatible endpoint in the UI only tests the connection
  and saves its key. To make it join a real meeting you still need a roster entry
  in the config file; adding that from the UI is **planned, not implemented**

`npm test` runs the meeting/tally/roster/permission/session-store tests plus
`tests/ui-contract.test.mjs`, a static contract check for the single-file panel
(dialog wiring, setting defaults, failure chain, path whitelist, breakpoints,
session-file concurrency, accent colour separation, clamping that does not
depend on `-webkit-box`, live-meeting progress data, honest abandon wording,
meeting-token isolation).
Static checks cannot prove a click path works. The round-4 acceptance run used
CDP-driven scripts in `tests/e2e/` against a real Electron window:

```bash
# from the project root, start a debug instance (Windows: .\node_modules\electron\dist\electron.exe)
./node_modules/electron/dist/electron.exe --no-sandbox \
  --remote-debugging-port=9446 --config=meeting.config.local.json electron/main.cjs

node tests/e2e/round4-e2e.mjs 9446   # progress card, abandon, background completion
node tests/e2e/round4-e2e2.mjs 9446  # decision book, reload guard, screenshots
node tests/e2e/round4-e2e3.mjs 9446  # per-model counters, idle prefetch, real meeting
node tests/e2e/round4-failure.mjs 9446 # background failure notice, no API keys needed
node tests/e2e/round5-usage.mjs 9446  # usage page (stubbed data, zero tokens)
```

The E2E drivers use the global `WebSocket`, so run them with **Node.js >= 22.4** (the normal test suite only requires >= 20.11).

## Release build

```bash
node scripts/release-build.mjs
```

Builds `release/win-unpacked` from the local Electron runtime (no GitHub download),
verifies the packaged `app.asar` (package.json parses, version matches, panel and
engine contain the current features), then writes
`release/meetingbot-<version>-portable.zip` and the npm tarball.

After the build, smoke-test the packaged app itself (CDP, no model calls):

```bash
node tests/e2e/packaged-smoke.mjs
```

Run it as the only build/test process. A build that raced the test suite once
produced an `app.asar` whose `package.json` was concatenated with an example brief;
the verification step now refuses to ship that build.

### Unsigned builds

This is a solo open-source project, so builds are **unsigned by design** (no code
signing certificate). Windows SmartScreen may show "unknown publisher" on first run.
That is expected; verify the download against `release/SHA256SUMS.txt` instead of
treating the binary as an identity statement. The build script writes that file on
every release.

Parts 1 and 3 start **real meetings** and therefore need configured API keys.
Part 4 stubs only the two meeting endpoints, so it needs no keys and calls no
model. The scripts write screenshots to `panel-screenshots/` and contain no
keys or machine paths. Unset `ELECTRON_RUN_AS_NODE` before starting (an empty
value still puts Electron into Node mode). See [docs/UX-ACCEPTANCE.md](docs/UX-ACCEPTANCE.md) for
the manual acceptance steps, and [docs/UX-AUDIT-ROUND3.md](docs/UX-AUDIT-ROUND3.md)
for the audit that produced the current behaviour.

## Presets

Presets are named attendee + thinking configurations:

```json
{
  "presets": {
    "one": {
      "label": "DeepSeek + MiMo",
      "agents": ["deepseek", "mimo"],
      "count": 2,
      "thinking": "low"
    },
    "two": {
      "label": "Qwen + MiMo + Wenxin",
      "agents": ["qwen", "mimo", "wenxin"],
      "count": 3,
      "thinking": "high"
    }
  }
}
```

```bash
node bin/meetingbot.mjs presets list --config meeting.config.local.json
node bin/meetingbot.mjs start --brief examples/brief.md --config meeting.config.local.json --preset one
```

`thinking` maps to `noThink` / `reasoning_effort` where the provider supports it.

## Choose the attendees

The roster can contain many models. You select who actually attends.

```bash
# choose exact agents
node bin/meetingbot.mjs start \
  --brief examples/brief.md \
  --config meeting.config.json \
  --agents deepseek,qwen,mimo

# choose a count, exclude expensive models, require tags
node bin/meetingbot.mjs start \
  --brief examples/brief.md \
  --config meeting.config.json \
  --count 3 \
  --exclude glm \
  --require-tags design \
  --max-cost-tier 2
```

`costTier` is operator-defined metadata:

```text
1 = cheap
2 = low
3 = medium
4 = high
5 = very expensive
```

Quality and cost are not inferred from the model name. You set them in the roster.

## Add a custom API entry

Any OpenAI-compatible endpoint can be a participant.

```bash
node bin/meetingbot.mjs providers add \
  --config meeting.config.json \
  --id kimi \
  --label Kimi \
  --base-url https://api.moonshot.cn/v1 \
  --model kimi-k2.7-code \
  --api-key-env KIMI_API_KEY \
  --tags code,long-context \
  --cost-tier 3 \
  --quality-tier 4
```

List and test:

```bash
node bin/meetingbot.mjs providers list --config meeting.config.json
node bin/meetingbot.mjs providers test --config meeting.config.json --id kimi
```

Keys are read from `apiKey` (inline), `apiKeyEnv`, the local encrypted vault, or `apiKeyFile`; they are never written to the run output.

## Config shape

```json
{
  "quorum": { "min": 2 },
  "dimensionWeights": { "architecture": 0.45, "aesthetics": 0.35, "security": 0.2 },
  "computerAccess": {
    "enabled": false,
    "mode": "worktree-only",
    "requiresOwnerApproval": true
  },
  "selection": {
    "count": 4,
    "maxCostTier": 3,
    "fallbacks": ["glm"]
  },
  "roster": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "provider": "openai",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "enabled": true,
      "tags": ["code", "reasoning", "cheap"],
      "costTier": 2,
      "qualityTier": 4
    }
  ]
}
```

### First-run compatibility

- The panel uses canonical ids (`ds-flash`, `glm-flash`, `qwen-flash`, `mimo-flash`, `wenxin-51`, `doubao-turbo`, `minimax-flash`).
- Example/older configs may use provider ids (`deepseek`, `glm`, `qwen`, `mimo`, `wenxin`, `doubao`) or raw model names. The backend resolves both through `src/model-aliases.mjs` for meetings, private chat, compression, vision review, and foreman revision.
- `examples/config.example.json` starts with `quorum.min: 2` and two selected models, so a first run with two keys is real rather than an `unknown or disabled agents` error.
- Config and vault keys are re-read on every API request. Adding a key in the panel refreshes the roster without restarting; a meeting still needs at least two selected models with keys.

### Decision integrity

- `tally.selfScorePolicy` defaults to `exclude`: a voter's own three-dimension scores are kept in `tally-audit.json` for comparison but removed from the aggregate. `downweight` (with `selfScoreWeight`) and `include` are explicit alternatives.
- Self rankings are removed from pairwise comparisons by default (`tally.stripSelfFromRanking`).
- `tally-audit.json` records `selfEvaluations` with self score, others' average, and delta.
- `decision.maxVetoes` defaults to `1`; the prompt and validator use the same limit.
- Elections and decisions are separate: `electedForeman` / `electedProposal` are the elected result; `actingForeman` / `failover` describe an emergency completion. A failover foreman has veto frozen and may only adopt the elected proposal.
- A decision that only validates through fallback normalization is rejected and the next foreman candidate is tried; `decision.fallback` stays visible in the audit. If every candidate fails, `actingForeman` is `null`, `ownerGate` is true, and reports say owner review is required.
- Veto entries are objects: `{proposal, category, reason}`. Allowed categories are `safety`, `scope`, `budget`, `infeasible`, `conflict`; strings and aesthetic disagreement are rejected/merged.
- `decision.quorum.valid: false` marks the decision blocked; do not build from it.
- When `buildGate` commands are configured (and `runOnMeeting` is not false), `runMeeting` executes them at the end and writes `gate.json`; a failing command marks `decision.blocked = true`.
- `buildGate.cwd` sets the target repository; it defaults to the config file's directory, not the runner's process cwd. `runOnMeeting: false` leaves the gate for the build entry.
- `node bin/meetingbot.mjs gate <run-dir> --command "npm test"` reruns the external gate later; `--command` overrides configured commands and `--cwd` sets the target.
- `decision.canBuild` is the single downstream check: it requires a passing gate, valid quorum, no owner gate, and no active failover. `buildGate.required` defaults to true only when commands are configured; a commandless greenfield run defaults to required false, so `canBuild` can be true without external gate evidence. If you want a commandless run blocked, set `buildGate.required: true` explicitly; if you configure commands, the default is fail-closed until they pass.
- `decision.ownerGateReasons` explains every block (no commands, failed gate, invalid quorum, failover, repaired decision).
- Mock runs record `buildGate.status = skipped` and do not execute commands.
- A repaired decision always sets `canBuild = false` until the gate is rerun.

**Config additions:**

```json
{
  "tally": {
    "selfScorePolicy": "exclude",
    "selfScoreWeight": 0,
    "stripSelfFromRanking": true,
    "voterTagBoost": 1.25
  },
  "decision": {
    "maxVetoes": 1,
    "budgetEscalationFactor": 1.6,
    "budgetEscalationCap": 50000
  },
  "buildGate": {
    "required": true,
    "runOnMeeting": true,
    "cwd": ".",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "test": "npm test"
  }
}
```

## Relay vs parallel

Parallel independent proposals preserve viewpoint diversity. A sequential relay
reduces duplicate ideas, but later models anchor on earlier framing.

Recommended default: **parallel proposals first**, then let a clerk deduplicate
into a short "already proposed / open gaps" digest, and send that digest only to
the critique round. A relay mode can be added as an optional flag, but should
not be the default.

## Provider status

Configured on this machine:

| Provider | Status |
|---|---|
| DeepSeek, GLM, Qwen, MiMo, Kimi, MiniMax | registered; Kimi/MiniMax not exercised in the 2-model test |
| Doubao / Volcano Ark | **enabled** — Evolving, 2.1-turbo, 2.1-pro; Pro used as foreman in the 3-model run |
| Wenxin / Baidu Qianfan | **enabled** — `ernie-5.1`, `noThink: true`, endpoint tested OK |

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for endpoints and activation notes.

## Why proposals are anonymous

Brand bias is real. If voters know P2 came from a famous model, the vote may measure the brand instead of the work.

`proposals/_index.json` keeps the mapping for audit after the meeting.

## Cost model

A 4-model meeting costs:

- 4 proposal calls
- 4 vote calls
- 1 foreman decision call

More than one agent, but less than a full build/test/fix cycle if it prevents a wrong architecture.

The first live test used 8,535 tokens for 3 successful proposals, 3 votes, and 1 decision. Token counts are recorded in `meta.json` and `transcript.jsonl`.

This is not proof that every meeting saves money. It is a measurable tradeoff.

## Current limits

- Meeting, multimodal review, and a local tool Agent; no generic shell tool
- Multimodal review sends failures back to the foreman for repair re-dispatch; it does not restore files or directories
- Permission modes are policy boundaries, not a VM: `self-review`/`full` run Python as the current Windows user
- Provider failures: exponential backoff (2s/4s/8s), configured fallback slots, and explicit missing-participant warnings; no health-aware pool yet
- Vote math: dimension-weighted aggregate with self-vote transfer, Condorcet winner, and weighted-average fallback for cycles; replayable via `tally()`
- Foreman output can fall back to a safe adopt if JSON is invalid
- `apiKey`/`apiKeyEnv`/the encrypted vault/`apiKeyFile` are resolved locally; this is not a hosted service
- `computerAccess` exists as a **disabled permission manifest** for the future builder; it cannot modify this machine in v2
- Default selection uses `selection.defaultPreset` (`one` = DeepSeek + MiMo, low) unless a preset is explicitly passed. Pro models are opt-in, not default.

## Roadmap

1. **v0.2** — attendee selection, custom providers, cost tags, HTML report, fallback slots
2. **v2.1** — pure `tally()` with self-transfer, Condorcet, cycle fallback, audit replay; three work modes; single roster store; multimodal review → foreman revision; DSH plugin market; context compression
3. **shipped in this build** — built-in browser/files/Python Agent, four permission modes (backend-enforced), owner interjection into critique/vote/decision
4. **next** — health-aware provider pool, per-domain calibration, isolated builder stage and tests
5. Public release after real-project validation

## License

Source-available under the **MeetingBot Community License 1.0.0**. Personal, enterprise, internal, client-project, and commercial use as a tool are permitted. Content you create with the Software belongs to you. Reselling the Software or a Derivative Work, or repackaging it for sale, is prohibited. This is not an OSI-approved open-source license. See [LICENSE](LICENSE) and [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
