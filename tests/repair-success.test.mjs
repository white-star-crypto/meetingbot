#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { repairDecision } from '../src/meeting.mjs'

const fake = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            adopt: ['P1'],
            veto: [],
            merge_plan: 'repair merge',
            risks: [],
            build_tasks: ['repair task'],
            code_structure: { modules: ['m'], flow: ['f'] },
            rationale: 'repaired',
          }),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
  })
})
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const { port } = fake.address()
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-repair-success-'))
try {
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({
    name: 'repair',
    roster: [{
      id: 'b',
      label: 'B',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'model-b',
      apiKey: 'test-key',
      enabled: true,
    }],
    quorum: { min: 1 },
    buildGate: { required: false },
  }), 'utf8')
  const runDir = path.join(dir, 'run')
  await fs.mkdir(path.join(runDir, 'proposals'), { recursive: true })
  await fs.writeFile(path.join(runDir, 'brief.md'), 'repair this run\n', 'utf8')
  await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
    config: configPath,
    selected: [{ id: 'b' }],
    errors: [],
  }), 'utf8')
  await fs.writeFile(path.join(runDir, 'votes.json'), JSON.stringify({
    winner: 'P1',
    foreman: 'b',
    electedForeman: 'b',
    failover: false,
    ranked: [],
    rows: [],
    tallyAudit: { method: 'condorcet', condorcetWinner: 'P1' },
  }), 'utf8')
  await fs.writeFile(path.join(runDir, 'proposals', 'P1.json'), JSON.stringify({
    id: 'P1', agentId: 'b', agentLabel: 'B', understanding: 'u', architecture: 'a', aesthetic: 'v', risks: [], confidence: 0.8, summary: 's',
  }), 'utf8')

  const result = await repairDecision({ runDir, configPath, timeoutMs: 120000 })
  assert.equal(result.runDir, runDir)
  assert.equal(result.decision.winner, 'P1')
  assert.equal(result.decision.foreman, 'b')
  assert.equal(result.canBuild, false)
  assert.equal(result.decision.repairRequiresGate, true)
  assert.equal(result.decision.repair.foreman, 'b')
  const md = await fs.readFile(path.join(runDir, 'decision.md'), 'utf8')
  assert.match(md, /^---\nschema: meetingbot\/decision\/v1/)
  const meta = JSON.parse(await fs.readFile(path.join(runDir, 'meta.json'), 'utf8'))
  assert.equal(meta.canBuild, false)
  assert.equal(meta.repairedFrom.electedForeman, 'b')
  console.log('PASS repair happy path writes decision/meta and returns')
} finally {
  fake.close()
  await fs.rm(dir, { recursive: true, force: true })
}
