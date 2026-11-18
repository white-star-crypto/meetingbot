#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCompareHistoryStore } from '../src/compare-history.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-compare-history-'))
try {
  const store = createCompareHistoryStore({ dataRoot: root })
  await store.add({ prompt: 'first', results: [{ ok: true, content: 'a' }] })
  await store.add({ prompt: 'second', results: [{ ok: true, content: 'b' }], merge: 'merged' })
  const rows = await store.list()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].prompt, 'second')
  assert.equal(rows[0].merge, 'merged')
  assert.equal(rows[1].prompt, 'first')
  console.log('PASS compare history: ordered dataRoot persistence')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
