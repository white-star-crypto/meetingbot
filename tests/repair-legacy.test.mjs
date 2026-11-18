#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { repairDecision } from '../src/meeting.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-repair-legacy-'))
try {
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({
    name: 'legacy',
    roster: [{
      id: 'b',
      label: 'B',
      provider: 'openai',
      baseUrl: 'https://example.invalid/v1',
      model: 'model-b',
      apiKey: 'test-key',
      enabled: true,
    }],
  }), 'utf8')
  const runDir = path.join(dir, 'run')
  await fs.mkdir(path.join(runDir, 'proposals'), { recursive: true })
  await fs.writeFile(path.join(runDir, 'brief.md'), 'legacy failover run\n', 'utf8')
  await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
    config: configPath,
    selected: [{ id: 'b' }],
    errors: [],
  }), 'utf8')
  await fs.writeFile(path.join(runDir, 'votes.json'), JSON.stringify({
    winner: 'P1',
    foreman: 'b',
    failover: true,
    ranked: [],
    rows: [],
    tallyAudit: {},
  }), 'utf8')
  await fs.writeFile(path.join(runDir, 'proposals', 'P1.json'), JSON.stringify({
    id: 'P1',
    agentId: 'b',
    agentLabel: 'B',
    understanding: 'u',
    architecture: 'a',
    aesthetic: 'v',
    risks: [],
    confidence: 0.8,
    summary: 's',
  }), 'utf8')

  await assert.rejects(
    () => repairDecision({ runDir, configPath }),
    /cannot verify elected foreman in legacy run/,
  )
  await fs.writeFile(path.join(runDir, 'votes.json'), JSON.stringify({
    winner: 'P1',
    foreman: 'b',
    ranked: [],
    rows: [],
    tallyAudit: {},
  }), 'utf8')
  await assert.rejects(
    () => repairDecision({ runDir, configPath }),
    /cannot verify elected foreman in legacy run/,
  )

  console.log('PASS legacy failover repair refuses instead of laundering acting foreman')
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
