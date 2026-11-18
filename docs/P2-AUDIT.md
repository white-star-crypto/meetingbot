# P2 close-out audit — 2026-11-09

This is the concrete P2 list used for the release review, not a claim that every
unreported issue in the world is gone. Each row has an executable check or a
documented boundary.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Group-chat `@label` substring matched multiple members | fixed | `tests/group-chat.test.mjs`, `tests/ui-contract.test.mjs` |
| 2 | Group-chat identity fallback could speak as another member | fixed | missing/disabled member now returns `member not available or disabled`; no first-member fallback |
| 3 | Roster custom participant IDs were dropped; single-model `one` preset was invalid | fixed | `tests/roster.test.mjs`, `tests/panel-auth.test.mjs` |
| 4 | Model alias label used substring matching | fixed | unique-prefix resolution; `tests/aliases.test.mjs` |
| 5 | Provider 429/5xx ignored `Retry-After` | fixed | `src/providers.mjs`, `tests/providers-timeout.test.mjs` |
| 6 | PR-review git refs could inject options | fixed | `src/pr-review.mjs`, `tests/pr-review.test.mjs` |
| 7 | Session deletes could be resurrected by a stale writer | fixed | tombstones in `src/session-store.mjs`; `tests/session-store.test.mjs` |
| 8 | `Number(x) || default` swallowed valid zero | fixed for maxVetoes and dimension weights | `src/config.mjs`, `src/tally.mjs` |
| 9 | `fs.write` overwrote existing files without human confirmation | fixed | one-time `confirmToken`; `tests/permissions.test.mjs` |
| 10 | provider-test DNS rebinding between validation and connect | fixed | pinned `lookup` in `requestPublic`; `tests/tools-ssrf.test.mjs` |
| 11 | Remote panel accepted `?token=` in URL | fixed | POST login form + `x-meetingbot-token`; `tests/panel-auth.test.mjs` |
| 12 | Remote panel was plaintext HTTP | fixed | TLS cert/key or PFX, explicit `--allow-insecure` opt-in; `tests/tls.test.mjs` |
| 13 | `rotateMaster` crash between master and vault writes | fixed | `.prev` master fallback; `tests/key-vault.test.mjs` |
| 14 | Strict Condorcet cycle aborted the whole meeting | fixed | ranked fallback + `tallyNoWinner` + `ownerGate`; `tests/tally.test.mjs` |
| 15 | UI contract was source-string-only | fixed for behavior | `tests/ui-contract.test.mjs`; `tests/ui-wiring.test.mjs` is explicitly a static wiring guard |
| 16 | Static panel assets bypassed auth | documented boundary | `docs/SECURITY.md`; assets contain no secrets |
| 17 | Build-gate timeout killed only the shell | fixed | Windows `taskkill /T /F`; `src/build-gate.mjs` |
| 18 | npm snapshot omitted runtime fixtures | fixed | review snapshot includes `examples/`, `public/panel.html`, `electron/*.cjs`; snapshot `npm test` exits 0 |
| 19 | Release artifacts excluded local secrets/logs | fixed | `scripts/check-pack.mjs` + `release:check` 123 files PASS |

## Remaining verification boundary

- The static wiring checks in `tests/ui-contract.test.mjs` are intentionally kept
  as fast syntax/wiring guards. They are not the only UI contract: real HTTP
  behavior is covered by `tests/ui-contract.test.mjs`.
- TLS is verified with a generated test PFX in `tests/tls.test.mjs`; production
  still needs the owner's certificate and private key.
