#!/usr/bin/env node
// Behavioral contract: exercise the real panel server over HTTP. The static wiring guard lives in
// tests/ui-wiring.test.mjs; this file proves auth, protected-file and API surfaces
// against a running server instead of asserting source strings.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startPanel } from '../src/panel-server.mjs'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-ui-contract-'))
process.env.MEETINGBOT_DATA_DIR = dataDir
const configPath = path.resolve(import.meta.dirname, '..', 'examples', 'config.mock.json')
const panel = await startPanel({ configPath, port: 0 })
const base = panel.url
const json = async (response) => JSON.parse(await response.text())
try {
  const noCookie = await fetch(base + '/api/config')
  assert.equal(noCookie.status, 401)

  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  const rawCookie = page.headers.getSetCookie?.()[0] || page.headers.get('set-cookie') || ''
  const cookie = rawCookie.split(';')[0]
  assert.match(cookie, /^meetingbot_session=[a-f0-9]{64}$/)
  const api = (url, options = {}) => fetch(base + url, { ...options, headers: { cookie, ...(options.headers || {}) } })

  assert.equal((await api('/api/config')).status, 200)
  assert.equal((await api('/api/roster')).status, 200)
  assert.equal((await api('/api/sessions')).status, 200)
  assert.equal((await api('/api/policy')).status, 200)
  assert.equal((await api('/api/mcp/status')).status, 200)

  const protectedRead = await api('/api/tools/fs/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: path.join(process.cwd(), 'config', 'providers.vault.json') }),
  })
  assert.equal(protectedRead.status, 403)
  assert.equal((await json(protectedRead)).code, 'PROTECTED_FILE')

  const localProvider = await api('/api/provider-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://192.168.1.1:9/v1', apiKey: 'x', model: 'm' }),
  })
  assert.equal(localProvider.status, 400)

  const probe = path.join(process.cwd(), 'state', `panel-write-${Date.now()}.txt`)
  await fs.mkdir(path.dirname(probe), { recursive: true })
  await fs.writeFile(probe, 'old')
  const bind = await api('/api/permissions/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: process.cwd() }) })
  assert.equal(bind.status, 200)
  const mode = await api('/api/permissions/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'workspace' }) })
  assert.equal(mode.status, 200)
  const noConfirm = await api('/api/tools/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: probe, content: 'new' }) })
  assert.equal(noConfirm.status, 409)
  const noConfirmBody = await json(noConfirm)
  assert.equal(noConfirmBody.code, 'CONFIRM_REQUIRED')
  assert.ok(noConfirmBody.confirmToken)
  const bypass = await api('/api/tools/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: probe, content: 'bypass', confirm: true }) })
  assert.equal(bypass.status, 409)
  const confirmed = await api('/api/tools/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: probe, content: 'new', confirmToken: noConfirmBody.confirmToken }) })
  assert.equal(confirmed.status, 200)
  const reused = await api('/api/tools/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: probe, content: 'again', confirmToken: noConfirmBody.confirmToken }) })
  assert.equal(reused.status, 409)
  await api('/api/permissions/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'read-only' }) })
  const readOnlyExisting = await api('/api/tools/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: probe, content: 'must-not-write' }) })
  assert.equal(readOnlyExisting.status, 403, 'read-only existing-file write must fail permission before confirmation')
  assert.equal((await json(readOnlyExisting)).code, 'PERMISSION_DENIED')
  assert.equal(await fs.readFile(probe, 'utf8'), 'new')
  await fs.unlink(probe)
  await api('/api/permissions/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'read-only' }) })

  const missingRun = await api('/api/meetings/does-not-exist')
  assert.equal(missingRun.status, 404)
  const disableMemory = await api('/api/plugins/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'memory', enabled: false }) })
  assert.equal(disableMemory.status, 200)
  const disabledMemoryRead = await api('/api/memory')
  assert.equal(disabledMemoryRead.status, 403, 'disabled plugin GET must be blocked too')
  await api('/api/plugins/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'memory', enabled: true }) })
  console.log('PASS UI behavior contract (HTTP auth, protected read, SSRF, routes, plugin GET gate)')
} finally {
  await new Promise((resolve) => panel.server.close(resolve))
  await fs.rm(dataDir, { recursive: true, force: true })
}
