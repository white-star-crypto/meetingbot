#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { createMcpManager } from '../src/mcp-client.mjs'

const server = {
  id: 'fake',
  label: 'Fake MCP',
  command: process.execPath,
  args: [path.resolve(import.meta.dirname, 'fixtures', 'mcp-server.mjs')],
  enabled: true,
  readOnly: false,
}
const baseConfig = { mcp: { enabled: true, timeoutMs: 5000, servers: [server] } }

const manager = createMcpManager({ config: baseConfig, permission: 'full' })
try {
  const tools = await manager.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].server, 'fake')
  assert.equal(tools[0].name, 'echo')
  const result = await manager.call({ server: 'fake', tool: 'echo', arguments: { value: 'hello' } })
  assert.equal(result.ok, true)
  assert.match(result.content, /hello/)
} finally {
  await manager.close()
}

const readOnlyManager = createMcpManager({ config: baseConfig, permission: 'read-only' })
try {
  const tools = await readOnlyManager.listTools()
  assert.equal(tools.length, 0, 'non-readOnly MCP server must not be listed in read-only mode')
  await assert.rejects(
    () => readOnlyManager.call({ server: 'fake', tool: 'echo', arguments: {} }),
    /not allowed in current permission/,
  )
} finally {
  await readOnlyManager.close()
}

const broken = createMcpManager({
  config: { mcp: { enabled: true, timeoutMs: 2000, servers: [{
    id: 'broken', command: process.execPath, args: [path.resolve(import.meta.dirname, 'fixtures', 'mcp-server-exit.mjs')], enabled: true,
  }] } },
  permission: 'full',
})
try {
  await assert.rejects(() => broken.call({ server: 'broken', tool: 'echo', arguments: {} }), /mcp|closed|exited|writable/i)
} finally {
  await broken.close()
}

const readOnlyConfig = {
  mcp: { enabled: true, timeoutMs: 5000, servers: [{ ...server, readOnly: true }] },
}
const safeManager = createMcpManager({ config: readOnlyConfig, permission: 'read-only' })
try {
  const tools = await safeManager.listTools()
  assert.equal(tools.length, 1)
  const result = await safeManager.call({ server: 'fake', tool: 'echo', arguments: { value: 'safe' } })
  assert.equal(result.ok, true)
} finally {
  await safeManager.close()
}

console.log('PASS MCP client initialize/list/call, permission filter, explicit readOnly opt-in')
