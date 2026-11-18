# Install and signing status

## Verified

- Native Electron 36.9.5 window on Windows 10: **yes**
- `MeetingBot.cmd` / `MeetingBot.lnk` opens the native window: **yes**
- Frameless window, custom minimize/maximize/close, no native menu: **yes**
- Agent-style thin scrollbar: **yes**
- Portable source + Electron runtime zip: **yes**

## Launch troubleshooting

The launcher (`MeetingBot.lnk` → `launch-app.ps1`, or `MeetingBot.cmd`) clears
three inherited environment variables before starting Electron, because an
IDE / agent / terminal host can inject them and break the window silently:

| Variable | Symptom |
|---|---|
| `ELECTRON_RUN_AS_NODE=1` | Electron runs as plain Node; `main.cjs` fails on `app.on` |
| `NODE_OPTIONS=--require=<host shim>` | Electron's bundled Node fails during preload, process exits with code 1 and no error text |
| `http_proxy` alongside `HTTP_PROXY` | Windows PowerShell 5.1 `Start-Process` throws "An item with the same key has already been added" |

`launch-app.ps1` is intentionally **ASCII-only**: Windows PowerShell 5.1 reads
`.ps1` as ANSI/GBK, so UTF-8 Chinese text without a BOM breaks the parser and
the launcher dies inside the window. Keep it ASCII; put user-facing Chinese in
the app itself.

The launcher now writes `launch.log` next to the scripts, checks that the
Electron process is still alive after 1.2 s, and falls back to a chromeless Edge
window against the local panel server if Electron exits. On failure the `.cmd`
shows the log and pauses instead of closing silently. The desktop shortcut uses
`-WindowStyle Normal` (not `Hidden`) so errors stay visible.

### The desktop shortcut must include `--no-sandbox`

On this machine Electron exits immediately when launched without
`--no-sandbox` — before `main.cjs` runs, so `startup.log` gets no new line at
all and the double-click looks like "nothing happened". Four-way A/B test:

| `electron.exe` arguments | result |
|---|---|
| `--no-sandbox main.cjs` | `window loaded` |
| `main.cjs` | exits immediately, no log |
| `"main.cjs"` | exits immediately, no log |
| `--no-sandbox "main.cjs"` | `window loaded` |

Quoting is not the issue; the flag is. `MeetingBot.lnk`, `launch-app.ps1`,
`MeetingBot.cmd` and `start-direct.cmd` all pass `--no-sandbox`. Any
user-created shortcut pointing straight at `electron.exe` must pass it too,
for example `--no-sandbox "<你的项目目录>\electron\main.cjs"`.

### Find the real desktop before editing a shortcut

`[Environment]::GetFolderPath('Desktop')` can be redirected. On the machine
used for verification it is `<redirected-desktop>`, **not**
`<default-desktop-path>`. The latter exists but is not shown on screen,
so a shortcut created there looks like "the icon never changed". Always resolve
the desktop path from the shell before creating or editing a shortcut.

### If a double-click appears to do nothing

`launch.log` gets a `launch start` line on every invocation. If its timestamp
does not change after a double-click, the shortcut never invoked the script —
a stale desktop icon, a click on empty space, or endpoint security software
blocking `powershell.exe -ExecutionPolicy Bypass`. That is not an application
crash, and no application log can explain it; ask the user what appeared on
screen.

A second entry, `start-direct.cmd` (copied to the desktop as
`合议-直接启动.cmd`), starts `electron.exe` with
`--no-sandbox electron/main.cjs` and no PowerShell at all. It is ASCII-only,
clears `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`, and relies on
`resolveConfigPath()` falling back to `meeting.config.local.json` at the app
root (so no `--config` argument with a non-ASCII path is needed). That fallback
was verified to reach `bootstrap start` -> `config=...` -> `panel listening`.

Launch from Explorer for a persistent window. Processes started from an
automation/agent host can be reaped when that host session ends, which looks
like "the window opened and immediately vanished" but is not an app defect.

## Built but not verified

- `dist/meetingbot 2.1.0.exe` portable executable: built (84 MB), then self-signed.
  It did not launch in this environment after signing; do not distribute it as
  working.
- NSIS installer: `electron-builder` generated a 158 KB stub and then failed while
  executing it. The installer is not usable.

## Signing

A self-signed code-signing certificate was generated for testing:

```text
CN=MeetingBot Dev, O=MeetingBot
```

The portable exe was signed with `signtool`. Windows reports:

```text
UnknownError
A certificate chain processed, but terminated in a root certificate
which is not trusted by the trust provider.
```

That is expected for a self-signed certificate. It is **not** a trusted release
signature. A real release requires a CA-issued code-signing certificate (or a
trusted signing service) and timestamping.

## Recommendation

Use the verified source/Electron portable zip for local testing. Do not call the
self-signed exe or the failed NSIS stub a release. The next installer attempt
should be made after deciding whether to buy a code-signing certificate.

## Data directory

Set `MEETINGBOT_DATA_DIR` to choose where `state/`, `feedback/`, caches, backups and export keys are written. If unset, the current working directory is used. Packaged Electron builds set it to Electron's `userData` directory automatically.
