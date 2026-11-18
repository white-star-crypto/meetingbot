#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPermissionStore } from '../src/permissions.mjs'
import { pythonRun } from '../src/tools.mjs'

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-data-ws-'))
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-data-root-'))
const previous = process.env.MEETINGBOT_DATA_DIR
try {
  await fs.mkdir(path.join(data, 'state'), { recursive: true })
  await fs.mkdir(path.join(data, 'config'), { recursive: true })
  await fs.writeFile(path.join(data, 'config', 'providers.vault.json'), '{}', 'utf8')
  await fs.writeFile(path.join(data, 'config', 'providers.vault.key'), 'secret', 'utf8')
  await fs.writeFile(path.join(data, 'state', 'permissions.json'), '{}', 'utf8')
  process.env.MEETINGBOT_DATA_DIR = data
  const permissions = createPermissionStore({
    statePath: path.join(data, 'state', 'permissions.json'),
    workspaceRoot: workspace,
    dataRoot: data,
    auditPath: path.join(data, 'state', 'audit.jsonl'),
  })
  assert.equal(permissions.current().id, 'read-only')
  assert.throws(() => permissions.assertRead(path.join(data, 'config', 'providers.vault.key')), (error) => error.code === 'PROTECTED_FILE')
  permissions.setMode({ mode: 'self-review', acceptDisclaimer: true })
  assert.throws(() => permissions.assertWrite(path.join(data, 'state', 'permissions.json'), { confirmToken: '' }), (error) => error.code === 'PROTECTED_FILE')
  const pythonPermissions = { ...permissions, current: () => ({ id: 'self-review' }) }
  const python = await pythonRun({
    permissions: pythonPermissions,
    cwd: workspace,
    code: 'print(open(r"' + path.join(data, 'config', 'providers.vault.key') + '").read())',
  })
  assert.equal(python.ok, false)
  const workspaceFile = path.join(workspace, 'backup-me.txt')
  await fs.writeFile(workspaceFile, 'backup me', 'utf8')
  const backup = permissions.backupFile(workspaceFile, 'test')
  assert.ok(backup.startsWith(path.join(data, 'state', 'backups') + path.sep), 'backup escaped data root')
  permissions.setMode({ mode: 'workspace' })
  assert.throws(() => permissions.assertPython(workspace), /Python|工作区/)
  delete process.env.MEETINGBOT_DATA_DIR
  const oldStore = createPermissionStore({
    statePath: path.join(workspace, 'state', 'permissions.json'),
    workspaceRoot: workspace,
    auditPath: path.join(workspace, 'state', 'audit.jsonl'),
  })
  assert.throws(() => oldStore.assertRead(path.join(workspace, 'state', 'permissions.json')), (error) => error.code === 'PROTECTED_FILE')
  console.log('PASS data root protection: fs and Python share data-root protected paths')
} finally {
  if (previous === undefined) delete process.env.MEETINGBOT_DATA_DIR
  else process.env.MEETINGBOT_DATA_DIR = previous
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(data, { recursive: true, force: true })
}

