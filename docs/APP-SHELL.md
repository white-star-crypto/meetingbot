# Standalone app shell — decision

## Recommendation

Use **Electron** for the first standalone release.

Verified on this machine: Electron **36.9.5** opens the native window. Electron
45 crashed at startup on this Windows 10 build. The main process is loaded
directly (`electron electron/main.cjs`), not via the package `.` entry.

Tauri would produce a smaller installer, but this machine has no Rust/cargo and
would require a Node sidecar.

## Why the app is needed

A browser tab is not a product. The app should:

- own a native window, tray icon, menu and installer
- start/stop the local meeting server in its main process
- keep config, presets and runs in a user data directory
- work without a separate `node` command
- expose the panel as the main UI
- optionally open the generated report in the system browser

## Default behavior

The default meeting is **autonomous**:

```text
brief → proposals → critique → vote → foreman decision → decision.md
```

No owner approval is required to finish. The user can interrupt, but silence is
the normal path.

`Ctrl+Enter` is an optional interjection, not a required step.

## Single-agent mode

The same window should support a private thread below the group meeting:

```text
[Group meeting]  Qwen + MiMo + Doubao Pro
──────────────────────────────────────────
[Private] DeepSeek
```

A private thread uses one selected agent, keeps its own history, and never joins
the group vote unless the user explicitly sends its result to the council.

## Single-instance / lifecycle

- single-instance lock
- close-to-tray, not close-to-exit by default
- explicit “Quit” menu
- local data under `%APPDATA%/MeetingBot`
- no silent auto-update; update prompt with changelog

## Packaging

- Electron main process starts the existing panel server on a random localhost port
- renderer loads that URL
- Node core is bundled as an asar/sidecar within the app
- first release: NSIS installer, unsigned; later: code signing + update channel
- expected size: roughly 100–150 MB, acceptable for v1

## Not in v1

- no unrestricted filesystem/shell access for agents
- no auto-install of third-party plugins
- no silent code changes
