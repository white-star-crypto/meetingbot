#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const out = mkdtempSync(path.join(os.tmpdir(), 'heyi-cli-json-'))
const run = (args) => spawnSync(process.execPath, ['bin/meetingbot.mjs', ...args], { cwd: root, encoding: 'utf8' })

try {
  const validate = run(['validate', '--config', 'examples/config.mock.json', '--json'])
  assert.equal(validate.status, 0, validate.stderr)
  const validated = JSON.parse(validate.stdout)
  assert.equal(validated.ok, true)
  assert.ok(validated.roster.every((p) => !('apiKey' in p)))

  const start = run(['start', '--brief', 'examples/brief.md', '--config', 'examples/config.mock.json', '--out', out, '--mock', '--json'])
  assert.equal(start.status, 0, start.stderr)
  const result = JSON.parse(start.stdout)
  assert.equal(result.ok, true)
  assert.equal('apiKey' in result.foreman, false, 'CLI JSON must not expose apiKey')
  assert.ok(!start.stdout.includes('apiKey'), 'CLI JSON must not expose apiKey anywhere')

  const decision = readFileSync(result.markdownPath, 'utf8')
  assert.match(decision, /^---\nschema: meetingbot\/decision\/v1/)
  assert.match(decision, /^canBuild: false$/m)

  const replay = run(['replay', result.runDir])
  assert.equal(replay.status, 0, replay.stderr)
  assert.match(replay.stdout, /Replay winner:/)
  assert.match(replay.stdout, /Saved winner:/)
  assert.doesNotMatch(replay.stdout, /MISMATCH/)

  const auditPath = path.join(result.runDir, 'tally-audit.json')
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
  audit.winner = 'P404'
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8')
  const mismatch = run(['replay', result.runDir])
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /MISMATCH: replay=.* saved=P404/)

  console.log('PASS CLI JSON / validate / decision front-matter / replay audit match')
} finally {
  rmSync(out, { recursive: true, force: true })
}
