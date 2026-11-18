# Local tool security

The Agent tools are real local operations. The permission mode is enforced by the local backend, not by prompt instructions.

## Defaults

- New installs start in `read-only`.
- `self-review` and `full` stay disabled until the user checks the disclaimer and sends `acceptDisclaimer: true`.
- The permission state lives in `state/permissions.json`.

## Boundaries

| Boundary | Enforcement |
|---|---|
| workspace writes | `realpath` canonicalization; a junction/symlink inside the workspace cannot resolve outside it |
| control files | `state/permissions.json`, `state/roster.json`, `state/audit.jsonl` are write-protected |
| delete | the file panel/API requires `confirm:true`; Agent-initiated deletes always require the owner's explicit approval in the panel, regardless of permission mode |
| self-review backups | existing files are copied to `state/backups` before overwrite/delete |
| Python | disabled in `read-only` and `workspace`. `self-review` uses best-effort audit-hook + `dir_fd`/`startfile` restrictions; `full` is explicitly unrestricted. Neither is an OS sandbox; native modules can still bypass the self-review wrapper. The child gets an explicit allowlist environment, not `process.env`. |
| browser reads | only `http(s)`; localhost/private/link-local hosts are blocked |
| panel API | bound to 127.0.0.1 by default; every `/api` except `/health` requires the session cookie, exact Host allowlist, and same-origin Origin; cookie is HttpOnly + SameSite=Strict with a 12h server-side TTL. If bound to `0.0.0.0`, Host must match one of the machine's actual interface addresses. |
| provider test | `baseUrl` must resolve to a public http(s) endpoint; a stored `keyName` may only be sent to that key's configured baseUrl |
| vision review | only local screenshots under `state/captures` / `panel-screenshots`; symlinks and paths outside those roots are rejected |
| MCP | opt-in stdio server; no fs/path allowlist, safety is explicit server config + `readOnly` + permission mode; treat a non-readOnly server as process-level access |
| output | file reads, Python output, and browser text are size-limited |
| observability | tool calls go to `state/audit.jsonl` |
| meeting output directory | `POST /api/meetings/start` accepts only a single relative folder name (`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,59}$`, no `..`); the resolved path must stay inside the application directory. A UI setting cannot widen this boundary. |
| open a local folder | Electron `open-path` exposes only a fixed whitelist (`state`, `audit`, `runs`, `config`) and re-checks the resolved path against the application root before `shell.openPath`. |
| API keys | keys saved from the panel go to the local encrypted `config/providers.vault.json`, resolved under the same `apiKeyEnv` name the config uses; they are never written to settings exports, logs, reports, or docs. |
| tool switches | `toolBrowser` / `toolFiles` / `toolPython` / `toolMcp` are enforced in the panel, the API layer, and `src/agent-runner.mjs`; hiding a button does not grant a capability, and showing it does not bypass the backend permission mode. |

## Ask policy

- `read-only`: ask before any write/install/system change.
- `workspace`: act inside the workspace; ask before leaving it, touching C:/system/registry, installing, or doing something irreversible.
- `self-review`: decide and act; ask only for C:/system/registry, irreversible operations, direction choices, or missing critical information.
- `full`: almost never ask; execute the task directly.

## Third-party plugins

The DSH plugin catalog is community-maintained. A listing is not an audit or endorsement. MeetingBot only displays the index and asks an Agent to analyze it; it does not install or execute plugin code. Anyone who installs or runs a third-party plugin is responsible for reviewing its source, permissions, dependencies, and license, and for any resulting loss or damage. MeetingBot and its contributors accept no liability.

## Not a VM

`self-review` and `full` are policy levels, not an OS sandbox. Python in those modes runs as the current Windows user and can do anything that user can do. That is exactly why those two modes require the disclaimer.

The built-in browser is a real Chromium webview. It denies permission prompts (camera/mic/geolocation), blocks popups, and restricts navigation to `http(s)`/`about:blank`.

## API

```text
GET  /api/permissions
POST /api/permissions/mode        { mode, acceptDisclaimer }
GET  /api/tools/state
POST /api/tools/fs/list           { path }
POST /api/tools/fs/read           { path }
POST /api/tools/fs/write          { path, content }
POST /api/tools/fs/mkdir          { path }
POST /api/tools/fs/delete         { path, confirm }
POST /api/tools/python/run        { code, cwd }
POST /api/tools/browser/read      { url, maxChars }
POST /api/agent/run               { agentId, task, maxSteps, disabledTools, allowQuestions }
POST /api/meetings/start          { brief, workMode, runDir, exportFormat }
```

The panel creates a random session token at startup and sets it as an
`HttpOnly; SameSite=Strict` cookie on the HTML response. All `/api` routes
(except `/health`) require that cookie, an exact `127.0.0.1:<port>` or
`localhost:<port>` Host, and a same-origin `Origin` when present. This blocks
drive-by pages and DNS rebinding even when the server is only bound to
loopback.

`maxSteps` is clamped to 2-8 by the API. `disabledTools` is filtered to
`browser | files | python | mcp`; anything else is ignored. `allowQuestions: false`
turns the Agent's `ask_user` action into an explicit "missing information" answer
rather than a prompt. These are UI preferences, not permission grants: the
backend permission mode remains the authority.

## Export bundles and remote panel

- `meeting export` writes an Ed25519-signed bundle. Verification pins the signer with `MEETINGBOT_EXPORT_PUBKEY` (PEM or `sha256:<fingerprint>`) or a TOFU file at `state/export-key.pub.pem`; a bundle re-signed by a different key is rejected after the first pin.
- A panel bound to a non-loopback `--host` refuses to start without `--token` or `MEETINGBOT_PANEL_TOKEN`, and refuses plaintext unless `--allow-insecure` is explicit. Use `--tls-cert cert.pem --tls-key key.pem`; remote browsers get a login form, and submitting the token sets the HttpOnly/Secure session cookie (12h TTL). API clients can use `x-meetingbot-token`; tokens are not accepted in the URL.
- Remote login is rate-limited per client IP: five failed attempts in 30 seconds returns 429. Wildcard binds are accepted only when the Host header matches an actual local interface address; arbitrary Host values are rejected.
- Remote HTTP is still plaintext. Use a trusted LAN, an SSH tunnel, or a TLS reverse proxy.

## Static panel assets

`panel.html` is token-gated in remote mode, but static JS/CSS/image assets remain readable without a session. They contain no secrets; never place API keys or private data in `public/`.

## Credential and control-file boundaries

`fs.read`, `fs.write` and `fs.delete` all reject the same protected set: `state/permissions.json`, `state/roster.json`, `state/audit.jsonl`, `config/providers.vault.json` and `config/providers.vault.key`. Python is disabled in workspace mode; self-review/full still apply the protected-path set. Agent-initiated `fs.delete` never receives `confirm=true`; deletion must be confirmed by the owner in the panel. This is intentional: a permission mode is not human consent.

## Read-only is not a whole-disk jail

Read-only and workspace modes may read ordinary files outside the workspace. The protected credential/control set is always denied to fs and Python (vault, export key, sessions/groups/policy, audit, SSH/AWS credentials, .env/.npmrc/.git-credentials). Do not treat read-only as a promise that arbitrary personal files cannot be disclosed.

## Vault key threat model

`config/providers.vault.key` is a base64-encoded master key protected with file mode `0600` where the platform honors it. On Windows, `chmod` does not create an ACL boundary: another process running as the same user can read the file and decrypt `providers.vault.json`. The vault protects against accidental commits, backups copied to another account, and casual cross-user access; it does **not** defend against a malicious process already running as the same Windows user. A future version may use Electron `safeStorage`/DPAPI; this build does not.
