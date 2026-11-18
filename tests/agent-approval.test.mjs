#!/usr/bin/env node
// A write to an existing file must become a real human approval round-trip:
// model asks to write -> backend returns needsInput -> owner answers 批准 ->
// server issues a one-time token -> the write is actually applied.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runAgentTask, resumeAgentTask } from '../src/agent-runner.mjs'
import { createPermissionStore } from '../src/permissions.mjs'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'heyi-approval-'))
const target = path.join(root, 'existing.txt')
await fsp.writeFile(target, 'old')
let calls = 0
const fakeModel = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    calls++
    const messages = (() => { try { return JSON.parse(body).messages || [] } catch { return [] } })()
    const approved = messages.some((message) => String(message.content || '').includes('用户已批准'))
    const content = approved
      ? JSON.stringify({ action: 'finish', answer: 'approved and written' })
      : JSON.stringify({ action: 'fs.write', args: { path: target, content: 'new' } })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
})
await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve))
const { port } = fakeModel.address()
const config = {
  participants: [{ id: 'fake', label: 'Fake', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake-model', apiKey: 'k', enabled: true, tags: [] }],
  maxTokens: 500,
  timeoutMs: 10000,
}
try {
  const permissions = createPermissionStore({
    statePath: path.join(root, 'state', 'permissions.json'),
    workspaceRoot: root,
    auditPath: path.join(root, 'state', 'audit.jsonl'),
  })
  permissions.setMode({ mode: 'workspace' })
  const first = await runAgentTask({ config, agentId: 'fake', task: 'edit existing file', permissions, maxSteps: 3 })
  assert.equal(first.needsInput, true)
  assert.equal(first.pendingApproval.kind, 'overwrite')
  assert.match(first.pendingApproval.preview || '', /old/)
  assert.match(first.pendingApproval.preview || '', /new/)
  assert.match(first.pendingApproval.previewSummary || '', /\+1/)
  const second = await resumeAgentTask({ config, state: first.state, answer: '批准', approved: true, permissions, maxSteps: 3 })
  assert.equal(second.ok, true)
  assert.equal(await fsp.readFile(target, 'utf8'), 'new')
  assert.ok(calls >= 2)
  console.log('PASS Agent overwrite approval round-trip writes after owner approval')
} finally {
  await new Promise((resolve) => fakeModel.close(resolve))
  await fsp.rm(root, { recursive: true, force: true })
}
