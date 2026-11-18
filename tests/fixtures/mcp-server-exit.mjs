#!/usr/bin/env node
// Deliberately close stdin before answering initialize; the client must reject
// the pending request instead of throwing an uncaught EPIPE.
process.stdin.destroy()
process.exit(0)
