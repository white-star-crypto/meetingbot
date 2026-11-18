#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runMeeting } from '../src/meeting.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-gate-live-'))
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = body.messages?.map((m) => m.content).join('\n') || ''
  let content
  if (prompt.includes('independent participant')) {
    content = JSON.stringify({ understanding: 'u', architecture: 'a', aesthetic: 'v', risks: [], confidence: 0.8, summary: 's' })
  } else if (prompt.includes('reviewer in a cross-debate')) {
    content = JSON.stringify({
      critiques: {
        P1: { architecture: 'a1', aesthetics: 'v1', security: 's1', keep: 'k1' },
        P2: { architecture: 'a2', aesthetics: 'v2', security: 's2', keep: 'k2' },
        P3: { architecture: 'a3', aesthetics: 'v3', security: 's3', keep: 'k3' },
      },
      best_aesthetic: 'P1',
      summary: 'd',
    })
  } else if (prompt.includes('You are a voter')) {
    content = JSON.stringify({
      vote_for: 'P1',
      scores: { P1: { architecture: 9, aesthetics: 9, security: 9 }, P2: { architecture: 8, aesthetics: 8, security: 8 }, P3: { architecture: 7, aesthetics: 7, security: 7 } },
      ranking: ['P1', 'P2', 'P3'],
      reason: 'P1',
    })
  } else {
    content = JSON.stringify({
      adopt: ['P1'], veto: [], rejected_strengths: [], merge_plan: 'm', risks: [], build_tasks: ['t'],
      code_structure: { modules: [], flow: [] }, rationale: 'r',
    })
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  await fs.writeFile(path.join(dir, 'brief.md'), 'gate integration test\n', 'utf8')
  const makeConfig = async (name, command) => {
    const configPath = path.join(dir, name + '.json')
    await fs.writeFile(configPath, JSON.stringify({
      name,
      maxTokens: 600,
      timeoutMs: 10000,
      selection: { count: 3, maxCostTier: 5 },
      quorum: { min: 2 },
      buildGate: command ? { required: true, runOnMeeting: true, cwd: '.', test: command } : undefined,
      roster: ['a', 'b', 'c'].map((id) => ({
        id,
        label: id.toUpperCase(),
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'model-' + id,
        apiKey: 'test-key',
        enabled: true,
        tags: [],
        costTier: 1,
        qualityTier: 3,
      })),
    }), 'utf8')
    return configPath
  }

  const passConfig = await makeConfig('pass', 'node --version')
  const pass = await runMeeting({ briefPath: path.join(dir, 'brief.md'), configPath: passConfig, outDir: path.join(dir, 'pass-runs'), selection: { agents: ['a', 'b', 'c'] } })
  assert.equal(pass.decision.buildGate.status, 'passed')
  assert.equal(pass.decision.canBuild, true)
  assert.equal(pass.decision.blocked, false)
  assert.equal(pass.decision.buildGate.cwd, dir)

  const failConfig = await makeConfig('fail', 'node -e "process.exit(1)"')
  const fail = await runMeeting({ briefPath: path.join(dir, 'brief.md'), configPath: failConfig, outDir: path.join(dir, 'fail-runs'), selection: { agents: ['a', 'b', 'c'] } })
  assert.equal(fail.decision.buildGate.status, 'failed')
  assert.equal(fail.decision.canBuild, false)
  assert.equal(fail.decision.blocked, true)
  assert.ok(fail.decision.ownerGateReasons.some((r) => r.includes('build gate failed')))

  console.log('PASS live meeting executes gate, canBuild reflects passed/failed')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
