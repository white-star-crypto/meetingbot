#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = await mkdtemp(join(tmpdir(), 'meetingbot-test-'))

try {
  const r = spawnSync(process.execPath, [
    'bin/meetingbot.mjs',
    'start',
    '--brief', 'examples/brief.md',
    '--config', 'examples/config.mock.json',
    '--out', OUT,
    '--mock',
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, `CLI failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`)

  const runs = await readdir(OUT)
  assert.equal(runs.length, 1, 'expected one run directory')
  const runDir = join(OUT, runs[0])
  const files = await readdir(runDir)
  for (const name of ['brief.md', 'roster.json', 'votes.json', 'critiques.json', 'decision.json', 'decision.md', 'meta.json', 'transcript.jsonl']) {
    assert.ok(files.includes(name), `missing ${name}`)
  }
  const decision = JSON.parse(await readFile(join(runDir, 'decision.json'), 'utf8'))
  assert.equal(decision.winner, 'P2')
  assert.equal(decision.mockRun, true, 'mock decisions must be recognizable downstream')
  assert.ok(decision.adopt.includes('P2'))
  assert.equal(new Set(decision.adopt).size, decision.adopt.length)
  assert.ok(decision.veto.length >= 1)
  assert.ok(!decision.adopt.includes(decision.veto[0].proposal))
  assert.equal(decision.veto[0].category, 'scope')

  const md = await readFile(join(runDir, 'decision.md'), 'utf8')
  assert.match(md, /Elected foreman/)
  assert.match(md, /P2/)
  assert.match(md, new RegExp(decision.veto[0].proposal))

  const meta = JSON.parse(await readFile(join(runDir, 'meta.json'), 'utf8'))
  assert.equal(meta.mode, 'mock')
  assert.equal(meta.foreman, decision.foreman)
  assert.ok(meta.selected.length >= 3)
  assert.ok(files.includes('report.html'))

  console.log('PASS MeetingBot mock meeting')
} finally {
  await rm(OUT, { recursive: true, force: true })
}
