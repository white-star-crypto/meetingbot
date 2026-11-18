# Notice

MeetingBot is a standalone meeting protocol.

- Runtime dependencies: none (Node.js built-ins only).
- No web framework, database, or model SDK is bundled.
- API providers are OpenAI-compatible endpoints configured by the operator.
- Mock mode is fully local and deterministic.
- The meeting core does not execute shell commands or modify project files. Optional Agent tools (fs.write and python.run) and build-gate can execute commands or modify files only after the owner selects a non-read-only permission mode; the default mode is read-only.

## License

MeetingBot is source-available under the MeetingBot Community License 1.0.0. Enterprise, internal, client-project, and commercial use as a tool is permitted. Content created with the Software belongs to the user. Reselling the Software or a Derivative Work, or repackaging it for sale, is prohibited. See `LICENSE` and `COMMERCIAL-LICENSE.md`.
