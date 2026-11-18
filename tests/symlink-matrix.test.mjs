#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPermissionStore } from '../src/permissions.mjs'
import { fsDelete, fsMkdir, fsWrite } from '../src/tools.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-symlink-matrix-'))
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-symlink-outside-'))
const makeStore = () => createPermissionStore({
  statePath: path.join(root, 'state', 'permissions.json'),
  workspaceRoot: root,
  auditPath: path.join(root, 'state', 'audit.jsonl'),
})
const target = path.join(outside, 'target.txt')
await fs.writeFile(target, 'target', 'utf8')
let symlinks = true
try {
  await fs.symlink(target, path.join(root, 'file-link'), 'file')
  await fs.symlink(outside, path.join(root, 'dir-link'), 'dir')
  await fs.symlink(path.join(outside, 'missing.txt'), path.join(root, 'dangling-link'), 'file')
} catch { symlinks = false }

try {
  for (const mode of ['read-only', 'workspace', 'self-review', 'full']) {
    if (symlinks) {
      await fs.rm(path.join(root, 'file-link'), { force: true })
      await fs.symlink(target, path.join(root, 'file-link'), 'file')
    }
    const permissions = makeStore()
    permissions.setMode({ mode, acceptDisclaimer: mode === 'self-review' || mode === 'full' })
    const normal = path.join(root, `normal-${mode}.txt`)
    if (mode === 'read-only') {
      assert.throws(() => fsWrite({ permissions, target: normal, content: 'x' }), (error) => error.code === 'PERMISSION_DENIED')
    } else {
      assert.equal(fsWrite({ permissions, target: normal, content: 'x' }).ok, true)
    }
    if (symlinks) {
      for (const link of ['file-link', 'dangling-link', 'dir-link']) {
        const targetPath = link === 'dir-link' ? path.join(root, link, 'new.txt') : path.join(root, link)
        assert.throws(() => fsWrite({ permissions, target: targetPath, content: 'escape' }), (error) => mode === 'read-only' || error.code === 'SYMLINK_DENIED', `${mode}: ${link} write should be denied`)
      }
      const deletePermissions = makeStore()
      deletePermissions.setMode({ mode: 'self-review', acceptDisclaimer: true })
      assert.equal(fsDelete({ permissions: deletePermissions, target: path.join(root, 'file-link'), confirm: true }).ok, true)
      assert.equal(await fs.readFile(target, 'utf8'), 'target', 'deleting a link must not delete its target')
    }
  }
  const permissions = makeStore()
  permissions.setMode({ mode: 'workspace' })
  assert.equal(fsMkdir({ permissions, target: path.join(root, 'new-dir') }).ok, true)
  assert.equal(fsMkdir({ permissions, target: path.join(root, 'new-dir') }).ok, true)
  console.log('PASS symlink matrix: normal/final/dangling/parent links across four modes')
} finally {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
}
