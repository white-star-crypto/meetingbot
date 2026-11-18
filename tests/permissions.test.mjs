#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createPermissionStore, mostRestrictiveMode } from '../src/permissions.mjs'
import { protectedPathsFor } from '../src/protected-paths.mjs'
import { executeAgentTool, fsDelete, fsRead, fsWrite } from '../src/tools.mjs'

const root = await mkdtemp(join(tmpdir(), 'heyi-permissions-'))
assert.equal(mostRestrictiveMode('full', 'workspace'), 'workspace')
assert.equal(mostRestrictiveMode('full', 'read-only'), 'read-only')
assert.equal(mostRestrictiveMode('self-review', 'full'), 'self-review')
assert.equal(mostRestrictiveMode('', 'full'), 'full')
try {
  fs.mkdirSync(join(root, 'state'), { recursive: true })
  const protectedFiles = protectedPathsFor({ root }).files
  for (const file of ['.npmrc', '.git-credentials', join('.config', 'git', 'credentials')]) {
    assert.ok(protectedFiles.includes(join(homedir(), file)), `missing home protection for ${file}`)
  }
  assert.ok(protectedFiles.some((file) => file.endsWith(join('state', 'export-key.pub.pem'))), 'missing TOFU pin protection')
  fs.mkdirSync(join(root, 'config'), { recursive: true })
  fs.writeFileSync(join(root, 'config', 'providers.vault.json'), '{}')
  fs.writeFileSync(join(root, 'config', 'providers.vault.key'), 'secret')
  const permissions = createPermissionStore({
    statePath: join(root, 'state', 'permissions.json'),
    workspaceRoot: root,
    auditPath: join(root, 'state', 'audit.jsonl'),
  })
  assert.equal(permissions.publicState().mode, 'read-only')
  assert.equal(permissions.publicState().workspaceBound, false, 'a default workspace must not count as user-bound')
  assert.throws(() => fsWrite({ permissions, target: join(root, 'a.txt'), content: 'x' }), /只读/)
  assert.throws(() => fsRead({ permissions, target: join(root, 'config', 'providers.vault.json') }), (error) => error.code === 'PROTECTED_FILE')
  assert.throws(() => fsRead({ permissions, target: join(root, 'config', 'providers.vault.key') }), (error) => error.code === 'PROTECTED_FILE')
  assert.throws(() => permissions.setMode({ mode: 'self-review' }), (error) => error.code === 'DISCLAIMER_REQUIRED')

  permissions.setMode({ mode: 'workspace' })
  assert.equal(fsWrite({ permissions, target: join(root, 'a.txt'), content: 'ok' }).ok, true)
  const otherRoot = await mkdtemp(join(tmpdir(), 'heyi-permissions-other-'))
  try {
    const next = permissions.setWorkspaceRoot(otherRoot)
    assert.equal(next.workspaceRoot, otherRoot)
    assert.equal(next.workspaceBound, true)
    assert.equal(fsWrite({ permissions, target: join(otherRoot, 'inside.txt'), content: 'ok' }).ok, true)
    assert.throws(() => fsWrite({ permissions, target: join(root, 'after-switch.txt'), content: 'no' }), /工作区/)
    const reloaded = createPermissionStore({
      statePath: join(root, 'state', 'permissions.json'),
      workspaceRoot: root,
      auditPath: join(root, 'state', 'audit.jsonl'),
    })
    assert.equal(reloaded.publicState().workspaceRoot, otherRoot, 'workspace root must persist')
    assert.equal(reloaded.publicState().workspaceBound, true, 'bound state must persist')
    assert.throws(() => permissions.setWorkspaceRoot(join(otherRoot, 'missing-dir')), (error) => error.code === 'INVALID_WORKSPACE_ROOT')
  } finally {
    await rm(otherRoot, { recursive: true, force: true })
  }
  permissions.setWorkspaceRoot(root)
  assert.throws(() => fsWrite({ permissions, target: join(root, 'a.txt'), content: 'overwrite' }), (error) => error.code === 'CONFIRM_REQUIRED')
  const overwriteToken = permissions.issueConfirmation('overwrite', join(root, 'a.txt'))
  assert.equal(fsWrite({ permissions, target: join(root, 'a.txt'), content: 'overwrite', confirmToken: overwriteToken.token }).ok, true)
  assert.throws(() => fsWrite({ permissions, target: join(root, '..', 'escape.txt'), content: 'no' }), /工作区/)
  assert.throws(() => fsWrite({ permissions, target: join(root, 'state', 'permissions.json'), content: 'no' }), /控制文件/)
  assert.throws(() => fsWrite({ permissions, target: join(root, 'config', 'providers.vault.json'), content: '{}' }), (error) => error.code === 'PROTECTED_FILE')
  assert.throws(() => fsWrite({ permissions, target: join(root, 'config', 'providers.vault.key'), content: 'x' }), (error) => error.code === 'PROTECTED_FILE')
  assert.throws(() => fsDelete({ permissions, target: join(root, 'a.txt'), confirm: false }), (error) => error.code === 'CONFIRM_REQUIRED')
  assert.equal(fsDelete({ permissions, target: join(root, 'a.txt'), confirm: true }).ok, true)
  try {
    const outsideDir = join(root, 'outside-dir')
    const linkDir = join(root, 'linked-dir')
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.symlinkSync(outsideDir, linkDir, 'dir')
    assert.throws(() => fsWrite({ permissions, target: join(linkDir, 'new.txt'), content: 'escape' }), (error) => error.code === 'SYMLINK_DENIED')
    assert.equal(fs.existsSync(join(outsideDir, 'new.txt')), false)
    fs.unlinkSync(linkDir)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  try {
    const outsideFile = join(root, 'outside-existing.txt')
    const link = join(root, 'existing-link')
    fs.writeFileSync(outsideFile, 'keep')
    fs.symlinkSync(outsideFile, link, 'file')
    assert.throws(() => fsWrite({ permissions, target: link, content: 'escape' }), (error) => error.code === 'SYMLINK_DENIED')
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep')
    fs.unlinkSync(link)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  try {
    const link = join(root, 'dangling-link')
    fs.symlinkSync(join(root, '..', 'outside-new.txt'), link, 'file')
    assert.throws(() => fsWrite({ permissions, target: link, content: 'escape' }), (error) => error.code === 'SYMLINK_DENIED')
    fs.unlinkSync(link)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  fs.writeFileSync(join(root, 'agent-delete.txt'), 'x')
  const pendingDelete = await executeAgentTool({ permissions, action: 'fs.delete', args: { path: join(root, 'agent-delete.txt') } })
  assert.equal(pendingDelete.needsConfirmation, true)
  assert.equal(pendingDelete.approval.kind, 'delete')
  assert.equal((await executeAgentTool({ permissions, action: 'fs.delete', args: { path: join(root, 'agent-delete.txt'), confirm: true }, approved: true })).ok, true)
  fs.writeFileSync(join(root, 'a.txt'), 'existing')
  const pendingWrite = await executeAgentTool({ permissions, action: 'fs.write', args: { path: join(root, 'a.txt'), content: 'again' } })
  assert.equal(pendingWrite.needsConfirmation, true)
  assert.equal(pendingWrite.approval.kind, 'overwrite')

  try {
    const outside = join(root, 'outside-target.txt')
    const link = join(root, 'delete-link')
    fs.writeFileSync(outside, 'keep')
    fs.symlinkSync(outside, link, 'file')
    permissions.setMode({ mode: 'self-review', acceptDisclaimer: true })
    assert.equal(fsDelete({ permissions, target: link, confirm: true }).ok, true)
    assert.equal(fs.existsSync(outside), true, 'deleting a link must not delete its target')
    assert.equal(fs.existsSync(link), false)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }

  permissions.setMode({ mode: 'self-review', acceptDisclaimer: true })
  assert.equal(permissions.current().id, 'self-review')
  assert.equal(permissions.publicState().accepted['self-review'], true)
  console.log('PASS permission gates')
} finally {
  await rm(root, { recursive: true, force: true })
}
