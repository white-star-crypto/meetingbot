#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runMeeting } from '../src/meeting.mjs'

const root = path.resolve(import.meta.dirname, '..')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-mock-pacing-'))
const brief = path.join(tmp, 'brief.md')
await fs.writeFile(brief, '# Mock pacing\n\nBuild a small page.\n', 'utf8')
const phases = []
const progress = []
const started = Date.now()
try {
  const result = await runMeeting({
    briefPath: brief,
    configPath: path.join(root, 'examples', 'config.mock.json'),
    outDir: path.join(tmp, 'runs'),
    mock: true,
    mockDelayMs: 5,
    mockSize: 7,
    parentRunId: 'parent-test',
    onPhase: (phase) => phases.push(phase),
    onProgress: (step) => progress.push(step),
  })
  const elapsed = Date.now() - started
  const meta = JSON.parse(await fs.readFile(path.join(result.runDir, 'meta.json'), 'utf8'))
  const proposalFiles = (await fs.readdir(path.join(result.runDir, 'proposals'))).filter((name) => /^P\d+\.json$/.test(name))
  assert.equal(proposalFiles.length, 7)
  assert.equal(meta.mockSize, 7)
  assert.equal(meta.parentRunId, 'parent-test')
  assert.ok(elapsed >= 50, `mock delay was not observable: ${elapsed}ms`)
  assert.ok(phases.includes('独立提案') && phases.includes('交叉批判') && phases.includes('Condorcet 投票'))
  assert.ok(progress.some((step) => step.phase === '独立提案' && step.total === 7 && step.done === 7))
  assert.ok(progress.some((step) => step.phase === '交叉批判' && step.done === step.total))
  assert.ok(progress.some((step) => step.phase === 'Condorcet 投票' && step.done === step.total))
  console.log('PASS mock-size / mock-slow / phase progress')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
