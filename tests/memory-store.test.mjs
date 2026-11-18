#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryStore } from '../src/memory-store.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-memory-'))
try {
  const store = createMemoryStore({ dataRoot: root })
  const first = await store.add('Prefer concise answers', 'test')
  const second = await store.add('Never expose keys', 'test')
  assert.equal((await store.list()).length, 2)
  assert.equal(first.source, 'test')
  assert.equal(await store.remove(second.id), true)
  assert.deepEqual((await store.list()).map((entry) => entry.text), ['Prefer concise answers'])
  const core = await store.add({ title: 'Core', text: 'Core rule', status: 'approved', core: true })
  assert.equal(core.core, true)
  const pending = await store.add({ title: 'Pending', text: 'Pending rule', status: 'pending', core: true })
  assert.equal(pending.core, false)
  // Importing an exported file must keep a rejected card rejected, and a
  // rejected card can never be core (it is not part of long-term memory).
  const rejected = await store.add({ title: 'Rejected', text: 'Rejected rule', status: 'rejected', core: true })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.core, false)
  // kind and tags are editable after creation.
  const edited = await store.update(rejected.id, { kind: 'decision', tags: ['a', 'b'] })
  assert.equal(edited.kind, 'decision')
  assert.deepEqual(edited.tags, ['a', 'b'])
  await store.update(core.id, { status: 'pending' })
  assert.equal((await store.list()).find((entry) => entry.id === core.id).core, false)
  const corruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-memory-corrupt-'))
  try {
    const file = path.join(corruptRoot, 'state', 'memory.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{not json', 'utf8')
    const corrupt = createMemoryStore({ dataRoot: corruptRoot })
    await assert.rejects(() => corrupt.list(), /corrupt/i)
    assert.equal(await fs.readFile(file, 'utf8'), '{not json')
  } finally {
    await fs.rm(corruptRoot, { recursive: true, force: true })
  }
  console.log('PASS memory store: add/list/remove, corrupt file refuses overwrite')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
