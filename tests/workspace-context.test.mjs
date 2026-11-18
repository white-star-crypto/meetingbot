#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectWorkspaceContext } from '../src/workspace-context.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-context-'))
try {
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'fake-dep'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'fake-dep': '^1.2.3' } }))
  await fs.writeFile(path.join(root, 'node_modules', 'fake-dep', 'package.json'), JSON.stringify({ name: 'fake-dep', version: '1.2.3', types: 'index.d.ts' }))
  await fs.writeFile(path.join(root, 'src', 'index.mjs'), 'export const value = 42\n')
  await fs.writeFile(path.join(root, '.env'), 'SECRET_TOKEN=do-not-send\n')
  const result = await collectWorkspaceContext({ root, brief: 'index value', maxFiles: 10 })
  assert.match(result.context, /src\/index\.mjs/)
  assert.match(result.context, /fake-dep@1\.2\.3/)
  assert.doesNotMatch(result.context, /do-not-send/)
  assert.ok(result.stats.files >= 2)
  console.log('PASS workspace context: source + dependency metadata, secrets excluded')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
