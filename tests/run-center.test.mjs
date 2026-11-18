#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listRuns } from '../src/run-center.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-run-center-'))
try {
  const run = path.join(root, 'runs', '20260101-000000')
  await fs.mkdir(run, { recursive: true })
  await fs.writeFile(path.join(run, 'meta.json'), JSON.stringify({ runId: 'r1', createdAt: '2026-01-01T00:00:00.000Z', mode: 'mock', brief: 'C:\\secret\\brief.md', roster: [{ id: 'a' }, { id: 'b' }], usage: { promptTokens: 3, completionTokens: 4 } }))
  await fs.writeFile(path.join(run, 'decision.json'), '{}')
  const selectedRun = path.join(root, 'runs', '20260102-000000')
  await fs.mkdir(selectedRun, { recursive: true })
  await fs.writeFile(path.join(selectedRun, 'meta.json'), JSON.stringify({ runId: 'r2', createdAt: '2026-01-02T00:00:00.000Z', mode: 'live', roster: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], selected: [{ id: 'a' }, { id: 'b' }] }))
  await fs.writeFile(path.join(selectedRun, 'decision.json'), '{}')
  const rows = await listRuns({ dataRoot: root })
  assert.equal(rows.length, 2)
  const r1 = rows.find((row) => row.id === 'r1')
  const r2 = rows.find((row) => row.id === 'r2')
  assert.equal(r1.id, 'r1')
  assert.equal(r1.brief, 'brief.md')
  assert.equal(r1.models, 2)
  assert.equal(r1.status, 'completed')
  assert.equal(r1.promptTokens + r1.completionTokens, 7)
  assert.equal(r2.models, 2, 'models must count selected participants, not the roster')
  console.log('PASS run center: scans runs without exposing absolute brief paths')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
