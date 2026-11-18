#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { runAgentTask } from '../src/agent-runner.mjs'

const fakeModel = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const messages = (() => { try { return JSON.parse(body).messages || [] } catch { return [] } })()
    const hasObservation = messages.some((message) => message.role === 'user' && String(message.content || '').startsWith('工具 mcp.call 的 observation'))
    const content = hasObservation
      ? JSON.stringify({ action: 'finish', answer: 'mcp agent ok' })
      : JSON.stringify({ action: 'mcp.call', args: { server: 'fake', tool: 'echo', arguments: { value: 'agent' } } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
  })
})

await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve))
const { port } = fakeModel.address()
const permissions = {
  root: process.cwd(),
  current: () => ({ id: 'full', label: '完全访问' }),
  audit: () => {},
}
const config = {
  participants: [{
    id: 'fake',
    label: 'Fake',
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'fake-model',
    apiKey: 'test',
    enabled: true,
    tags: [],
    costTier: 1,
    qualityTier: 1,
  }],
  maxTokens: 1000,
  timeoutMs: 10000,
  mcp: {
    enabled: true,
    timeoutMs: 5000,
    servers: [{
      id: 'fake',
      label: 'Fake MCP',
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, 'fixtures', 'mcp-server.mjs')],
      enabled: true,
      readOnly: false,
    }],
  },
}

try {
  const result = await runAgentTask({ config, agentId: 'fake', task: 'call the MCP echo tool', permissions, maxSteps: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.answer, 'mcp agent ok')
  assert.ok(result.trace.some((step) => step.action === 'mcp.call' && step.ok === true))
  const blocked = await runAgentTask({ config, agentId: 'fake', task: 'call blocked mcp', permissions, maxSteps: 3, disabledTools: ['mcp'] })
  assert.equal(blocked.ok, true)
  assert.ok(blocked.trace.some((step) => step.action === 'mcp.call' && step.ok === false), 'disabledTools mcp must block the call')
  console.log('PASS MCP can be disabled by UI disabledTools')
  console.log('PASS Agent MCP dispatch → observation → finish')
} finally {
  fakeModel.close()
}
