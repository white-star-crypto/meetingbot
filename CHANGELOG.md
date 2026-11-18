# Changelog

## 1.0.0 — 2026-11-14 (V1 release candidate)

- First public-version candidate: multi-model meeting (proposals → critique →
  Condorcet vote → foreman decision), decision book, per-meeting permission,
  workspace binding, approval/audit trail, official plugins, and the optional
  read-only 副屏 companion.
- Feature freeze for V1. The 副屏 remains default-off; no interactive browser or
  AI-copilot features were added.
- The voluntary “支持合议” settings entry is disabled for V1; the code is kept
  dormant so a later update can restore it if usage justifies it.
- Build is currently **unsigned**; signing and auto-update are release-engine
  work still pending. Do not describe the unsigned RC as Signed or as the final
  public release.
- Independent bug audit (2026-11-14) fixed confirmed defects:
  - background-job cancellation now actually stops the Agent loop;
  - Python execution is asynchronous and no longer freezes the panel server;
  - approval audit records the effective (most restrictive) permission;
  - resume-by-approval honors `disabledTools`;
  - Python HTTP default cwd follows the bound workspace;
  - decision approval uses an `approved → executing → executed` state so two
    concurrent requests cannot execute the same approval twice.
  - Remaining hypothesis BUG-7 (cwd/runDir) is documented as a V1 limitation,
    not silently changed. See `docs/BUG-AUDIT-TRIAGE-1.0.0.md`.
- Second independent audit (R2) fixed:
  - plugin catalog streams downloads with a hard byte cap and caps gzip output
    (no Content-Length or a gzip bomb cannot exhaust memory);
  - Electron window/navigation checks compare parsed origins, rejecting
    userinfo URLs such as `http://127.0.0.1:1@evil.example/`;
  - stale `executing` approvals are released after a process restart;
  - directory-delete backups do not follow junctions/symlinks and have a
    256MB cap;
  - partial proposal resumes regenerate the full proposal set instead of
    silently shrinking the committee;
  - the server rejects non-read-only mode changes until a workspace is bound;
  - read-only writes to existing files return `PERMISSION_DENIED`, not a fake
    `CONFIRM_REQUIRED`;
  - official plugin counts use the same `OFFICIAL_PLUGINS` list.
- Third independent audit (R3) fixed:
  - **P0 Python sandbox:** guard state moved into a closure; user code runs in
    a separate namespace; guard entry deleted before user code; `realpath`,
    `fspath`, `fsdecode`, separator and open flags are captured so rebinding
    globals or `os.path.realpath` no longer reads protected credentials;
  - an executing approval blocks creating/authorizing a second approval for the
    same run (`DECISION_APPROVAL_EXECUTING`);
  - `agentSessions` now has a 24h TTL and 200-entry cap;
  - feedback version fallback is `unknown`, not the stale `2.2.0`.
- Fourth independent audit (R4) fixed:
  - approval recovery now checks the executing PID (a live second process is
    not treated as crashed; dead PIDs are released);
  - single-instance lock was removed because it blocked packaged startup on the
    test machine; PID liveness + approve/authorize guards carry the invariant;
  - open-path/capture use the packaged data root; plugin GET routes honor the
    disabled state; SSE connections are closed on quit; file-preview uses the
    bound workspace root.
  - `aesthetic` vs `aesthetics` was a false positive (proposal field vs vote
    dimension), not changed.
- Fifth independent audit (R5) fixed:
  - meeting start claims `state.running` before the execution-intent await, so
    a double click cannot start two live meetings;
  - Python runs with `-X utf8`, independent of the ignored
    `PYTHONIOENCODING` under `-I`;
  - `ask_user` resume keeps the executor scope;
  - npm catalog redirects are followed manually with per-hop URL validation;
  - an empty resume answer no longer injects the literal `undefined`.
- Provider UI (2026-11-16):
  - custom OpenAI-compatible endpoints can now be added to the config roster
    directly from the panel (atomic write, duplicate update, backup rollback);
  - "发现 / 刷新模型" sends the entered key and pulls the provider's live
    `/models`; discovered models can be added to the roster and selected for
    meetings;
  - the old "only saves a key, edit README" notice is gone;
  - Settings now has "管理模型": pick a provider, refresh `/models` with the
    saved vault key, and add models that were not in the initial two.
- Account UI (2026-11-16):
  - signed-in users no longer see email/password, GitHub/Google, login or
    register controls; the modal shows the current account and a
    "切换账号" action instead;
  - sync buttons are disabled while signed out; menu logout only appears when
    signed in.
- Final verification: `npm test` EXIT 0 (UI contract **96 checks**),
  packaged smoke **26/26**, `check-pack` **242 files**, packguard PASS,
  SHA-256 **4/4**.- Previous internal history remains below (2.4.1 and earlier).

## 2.4.1 — 2026-11-12

- Catalog refresh now tries the upstream **`dsh-plugin-catalog` npm package**
  through **npmmirror** first (`metadata → tarball → package/plugins.json`).
  This is the domestic route and works before the MeetingBot repository is
  published.
- Fallbacks: jsDelivr’s copy of the same package file, then the self-hosted
  `public/dsh-plugins.json` on `main`, then GitHub raw. On the test machine
  `raw.githubusercontent.com` fails at the network layer (ENOENT), so it stays
  last.
- Failure messages now name every attempted host and cause instead of a bare
  `fetch failed`.
- **Built-in “副屏” official plugin (default off).** When enabled in
  「插件」→「官方插件管理」, the top bar gets a 副屏 toggle that opens a
  resizable right-hand AI dock inside the same window. The dock embeds the
  read-only companion view (phase, participants, progress, decision book) and
  has a separate “投到副屏” action for a physical second display. The plugin is
  off on fresh profiles; disabling it closes both the dock and the external
  window. This is app-level split view, not a Windows virtual-display driver.
  Fixed: the top-bar entry's `hidden` state was overridden by the small-button
  `display` rule, so a disabled plugin still showed the entry; regression test
  now checks computed style, not just the attribute.
- **Built-in secondary-display companion.** When Windows exposes a second
  display, the top bar gets a **副屏** button. It opens a read-only
  `companion.html` window on that display with live phase, participant status,
  progress and the decision book. It is created with `showInactive()` so
  opening it does not steal focus or cover the user's main screen; closing it
  does not close the meeting. Single-display machines show the button disabled.
  Uses Electron `screen`/`BrowserWindow` only — no Deskreen/WebRTC dependency.
- **First-run workspace gate.** A fresh desktop profile opens “先绑定工作区”
  before normal use: choose a folder, or explicitly continue in read-only mode.
  Switching to workspace/self-review/full when no folder is bound forces the
  picker first; cancelling leaves the old permission unchanged. Existing
  unbounded workspace states are downgraded to read-only on load instead of
  silently using the app directory.
- **Workspace folder is now selectable and persisted.** The permissions page
  has a folder picker (`工作区文件夹`); the chosen absolute directory becomes
  the root for workspace reads/writes, the file tool's default listing, Python
  cwd, Agent prompt and checkpoint checks. Invalid/missing paths are rejected
  with `INVALID_WORKSPACE_ROOT`; the choice is audited and stored in
  `permissions.json`.
- No Gitee `plugins.json` mirror exists yet; Gitee can be used via
  `MEETINGBOT_PLUGIN_CATALOG_URL` once a mirror is published.
- This is a patch fix folded into 2.4.1; no extra version bump for it.

## 2.4.0 — 2026-11-12

### Plugin catalog refresh

- Added a manual **刷新目录** button to the plugin market. It fetches the
  catalog over HTTPS, validates size/shape/count, computes SHA-256, writes the
  cache atomically and reloads the list.
- The bundled `public/dsh-plugins.json` remains the offline fallback. A failed
  refresh (offline, HTTP error, bad JSON, oversized file, schema failure) keeps
  the previous cache/bundled catalog and says so in the UI.
- Official MeetingBot plugins are still code shipped with the app; the catalog
  only refreshes entries and links. It never installs or executes code.
- Cache: `state/plugin-catalog.json`. UI reads `/api/plugins/catalog`; manual
  refresh is `POST /api/plugins/catalog/refresh`.
- Configurable source via `MEETINGBOT_PLUGIN_CATALOG_URL`; production URLs must
  be HTTPS and are blocked from private/localhost hosts. See
  `docs/PLUGIN-CATALOG.md`.
- Tests: catalog normalization/URL guard/atomic cache/SHA/second refresh/failure
  fallback, HTTP bundled → refresh → cached with a bad-refresh 502 fallback.
- `npm test` UI contract is now **92 checks**; packaged smoke **25/25**;
  `check-pack` 218 files.

## 2.3.9 — 2026-11-12

### Foreman picker moved into the model panel

- The “主 Bot” dropdown left the composer bar. It now sits in the **选择模型**
  panel, directly above 置顶 / 预设, where roster decisions belong.
- Choosing a model marks its selected-model card with a small **主 Bot** badge;
  “自动 · 匿名投票选” remains the default.
- The new-meeting dialog still offers a per-meeting override. A direct composer
  start uses the model-panel choice.
- Removed the now-duplicate composer dropdown, so the control has one primary
  home.

### Verification

- `npm test` / UI wiring checks (89) and manual-foreman engine test pass.
- CDP check with the real roster: panel options list keyed models; selecting one
  updates `state.settings.foremanId` and renders exactly one “主 Bot” badge.
- Packaged 2.3.9 smoke **22/22**, `check-pack` 209 files, SHA-256 **4/4**.

## 2.3.8 — 2026-11-12

### UI fixes

- The meeting header is now a **full-bleed bar attached to the top edge** of the
  meeting view instead of a floating 820px strip with side and top gaps.
  Its content still aligns to the 820px reading column; the live roster/config
  chip was removed from the bar because the progress card is authoritative.
- Empty recovery banners no longer occupy space: `.recovery-banner[hidden]`
  now really hides (its `display:flex` used to override the `hidden` attribute,
  leaving a 56px blank band above the meeting header).
- Added an explicit “主 Bot” selector to the composer bar and the new-meeting
  dialog.

### Owner-appointed foreman

- By default nothing changes: proposals → critique → anonymous vote → the
  winning proposal's author becomes foreman.
- The owner can optionally appoint any keyed participant as foreman. The vote
  still ranks proposals for the decision book, but the appointed model makes
  the final decision; the prompt, decision JSON, `meta.json` and the decision
  page all record `foremanSelection: "owner"` and the requested model.
- The server rejects a foreman outside the selected roster. If the appointed
  foreman fails, the existing failover rules still apply (veto frozen, elected
  proposal preserved), and the failure is visible.
- The selector is optional: no selection = the original anonymous election.

### Verification for this build

- `npm test` — **89 UI contract checks** plus engine/security/approval/permission
  suites; new manual-foreman engine test covers owner selection, auto fallback
  and invalid-foreman rejection.
- Packaged `合议.exe` smoke **22/22**, `npm pack` install + CLI pass, `check-pack`
  208 files, SHA-256 verified.

## 2.3.7 — 2026-11-12 — first open-source release candidate

MeetingBot is a local-first, multi-model meeting app for software work: models
propose independently, critique each other, vote, and a foreman writes a decision
book. Execution is optional, permission-gated, and always approved by a human.

### Highlights

- **Meeting engine** — proposal → critique → Condorcet vote → foreman decision;
  council / division / on-demand work modes; owner interjections during a run.
- **Decision book** — conclusion, acceptance, election, execution checklist,
  risks, proposals, usage link, Markdown export, and a decision ledger.
- **Decision Ontology (local)** — claims / evidence / decisions, auto-mined draft
  terms, coverage queries, an SVG evidence graph, and cross-run `supersedes`.
- **Answerability gate** — if certified ontology coverage is below 50%, approval
  requires an explicit “still execute” reason; the reason is stored on the
  approval and audited. Execution re-checks legacy approvals.
- **Per-meeting permission** — each meeting remembers the mode it started under.
  Execution uses the stricter of that mode and the current global permission; a
  meeting can narrow access but never widen it.
- **Refresh reattach** — a reload reconnects to the running meeting by id and
  resumes progress without starting a second run or billing twice.
- **Execution approval** — task scope, one-shot approval (`executed` / 409),
  allowed-path whitelist (`SCOPE_DENIED`), pre-execution named-file preview, and
  checkpoint restore.
- **Usage center** — token counts, coverage and failures only. No money estimate:
  discounts, peak pricing and cache discounts cannot be determined locally.
- **Plugin market** — official plugins plus an opt-in `anidoodle` external skill
  (Apache-2.0, default off, never bundled or auto-executed).
- **Desktop packaging** — Electron portable zip, npm tarball, SHA-256 checksums,
  unsigned by design.

### Verification for this release

- `npm test` — 88 UI contract checks plus engine, security, approval, permission,
  ontology, external-skill and file-preview suites.
- Real mock meeting e2e: start → UI reattach → live refresh → decision → session.
- Historical decision book + answerability + per-meeting permission e2e.
- Packaged `合议.exe` smoke: 22 checks, no page exceptions.
- `npm pack` install smoke: package installs and `meetingbot --help` runs.
- `packguard` clean; SHA-256 verified for the zip, tarball and executable.

### Known limits

- Windows-first desktop build; the e2e browser checks currently assume Edge.
- No remote/mobile client. No full event sourcing; run state is a snapshot plus
  per-run files, sufficient for the single-user local workflow.
- No cost estimate by design.
- Builds are unsigned; verify `SHA256SUMS.txt` and the source instead.
- Third-party catalog entries and external skills are not audited or endorsed.

