#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runBuildGate } from '../src/build-gate.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-gate-'))
try {
  await fs.writeFile(path.join(dir, 'decision.json'), JSON.stringify({
    quorum: { valid: true },
    buildGate: { required: true, commands: ['node --version'] },
  }, null, 2), 'utf8')

  const passed = await runBuildGate({ runDir: dir, commands: ['node --version'] })
  assert.equal(passed.status, 'passed')
  const decision = JSON.parse(await fs.readFile(path.join(dir, 'decision.json'), 'utf8'))
  assert.equal(decision.blocked, false)
  assert.equal(decision.buildGate.status, 'passed')
  assert.equal(decision.buildGate.results[0].ok, true)
  assert.ok(await fs.readFile(path.join(dir, 'gate.json'), 'utf8'))

  const fallbackDir = path.join(dir, 'fallback')
  await fs.mkdir(fallbackDir)
  await fs.writeFile(path.join(fallbackDir, 'decision.json'), JSON.stringify({
    quorum: { valid: true },
    fallback: true,
    ownerGate: true,
    blocked: true,
    buildGate: { required: true, commands: ['node --version'] },
  }), 'utf8')
  const fallbackPassed = await runBuildGate({ runDir: fallbackDir, commands: ['node --version'] })
  const fallbackDecision = JSON.parse(await fs.readFile(path.join(fallbackDir, 'decision.json'), 'utf8'))
  assert.equal(fallbackPassed.status, 'passed')
  assert.equal(fallbackDecision.ownerGate, true, 'gate pass must not clear fallback owner gate')
  assert.equal(fallbackDecision.canBuild, false, 'fallback decision must remain unbuildable')

  const legacyDir = path.join(dir, 'legacy-fallback')
  await fs.mkdir(legacyDir)
  await fs.writeFile(path.join(legacyDir, 'decision.json'), JSON.stringify({
    quorum: { valid: true },
    fallback: true,
    buildGate: { required: false, commands: [] },
  }), 'utf8')
  const legacy = await runBuildGate({ runDir: legacyDir })
  const legacyDecision = JSON.parse(await fs.readFile(path.join(legacyDir, 'decision.json'), 'utf8'))
  assert.equal(legacy.status, 'unverified')
  assert.equal(legacyDecision.ownerGate, true)
  assert.equal(legacyDecision.canBuild, false)

  const invalidPath = path.join(dir, 'invalid')
  await fs.mkdir(invalidPath)
  await fs.writeFile(path.join(invalidPath, 'decision.json'), JSON.stringify({
    quorum: { valid: false },
    buildGate: { required: true, commands: ['node --version'] },
  }), 'utf8')
  const blocked = await runBuildGate({ runDir: invalidPath, commands: ['node --version'] })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.quorumValid, false)
  assert.equal(blocked.results.length, 0)

  console.log('PASS build gate blocks invalid quorum and records command results')
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
