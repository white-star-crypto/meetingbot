#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { callChat } from '../src/providers.mjs'

const server = http.createServer(() => {
  // Deliberately never respond: callChat must abort and must not retry with an
  // already-aborted controller.
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  const participant = {
    id: 'slow',
    model: 'slow-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    provider: 'openai',
    apiKey: 'test',
  }
  const started = Date.now()
  await assert.rejects(
    () => callChat(participant, [{ role: 'user', content: 'hi' }], { maxTokens: 8, timeoutMs: 1000 }),
    /timed out after 1000ms/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `timeout should not retry four times; took ${elapsed}ms`)
  console.log('PASS provider timeout aborts one attempt instead of reusing an aborted signal')
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}
