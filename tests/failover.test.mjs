#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runMeeting } from '../src/meeting.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-failover-'))
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const prompt = body.messages?.map((m) => m.content).join('\n') || ''
  const model = body.model
  let content = '{}'
  let finishReason = 'stop'

  if (prompt.includes('independent participant')) {
    const id = model === 'model-a' ? 'P1' : model === 'model-b' ? 'P2' : 'P3'
    content = JSON.stringify({
      understanding: `understanding ${id}`,
      architecture: `architecture ${id}`,
      aesthetic: `aesthetic ${id}`,
      risks: [],
      confidence: 0.8,
      summary: `summary ${id}`,
    })
  } else if (prompt.includes('reviewer in a cross-debate')) {
    content = JSON.stringify({
      critiques: {
        P1: { architecture: 'a1', aesthetics: 'v1', security: 's1', keep: 'k1' },
        P2: { architecture: 'a2', aesthetics: 'v2', security: 's2', keep: 'k2' },
        P3: { architecture: 'a3', aesthetics: 'v3', security: 's3', keep: 'k3' },
      },
      best_aesthetic: 'P3',
      summary: 'debate',
    })
  } else if (prompt.includes('You are a voter')) {
    content = JSON.stringify({
      vote_for: 'P1',
      scores: {
        P1: { architecture: 9, aesthetics: 9, security: 9 },
        P2: { architecture: 8, aesthetics: 8, security: 8 },
        P3: { architecture: 7, aesthetics: 7, security: 7 },
      },
      ranking: ['P1', 'P2', 'P3'],
      reason: 'P1 is strongest',
    })
  } else if (prompt.includes('elected foreman') || prompt.includes('acting foreman')) {
    if (model === 'model-a') {
      content = '{"adopt":["P1"]}'
    } else {
      content = JSON.stringify({
        adopt: ['P3'],
        veto: [{ proposal: 'P1', category: 'scope', reason: 'trying to veto the elected proposal' }],
        rejected_strengths: [],
        merge_plan: 'repair plan',
        risks: [],
        build_tasks: ['task'],
        code_structure: { modules: [], flow: [] },
        rationale: 'acting repair',
      })
    }
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  const configPath = path.join(dir, 'config.json')
  const briefPath = path.join(dir, 'brief.md')
  await fs.writeFile(briefPath, 'Test failover authority.\n', 'utf8')
  await fs.writeFile(configPath, JSON.stringify({
    name: 'failover-test',
    maxTokens: 800,
    timeoutMs: 10000,
    selection: { count: 3, maxCostTier: 5 },
    quorum: { min: 2 },
    decision: { maxVetoes: 1 },
    buildGate: { required: true, runOnMeeting: true, test: 'node --version' },
    roster: ['model-a', 'model-b', 'model-c'].map((model, i) => ({
      id: String.fromCharCode(97 + i),
      label: `Agent ${String.fromCharCode(65 + i)}`,
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model,
      apiKey: 'test-key',
      enabled: true,
      tags: [],
      costTier: 1,
      qualityTier: 3,
    })),
  }, null, 2), 'utf8')

  const result = await runMeeting({ briefPath, configPath, outDir: path.join(dir, 'runs'), selection: { agents: ['a', 'b', 'c'] } })
  const decision = JSON.parse(await fs.readFile(path.join(result.runDir, 'decision.json'), 'utf8'))
  const votes = JSON.parse(await fs.readFile(path.join(result.runDir, 'votes.json'), 'utf8'))
  const meta = JSON.parse(await fs.readFile(path.join(result.runDir, 'meta.json'), 'utf8'))
  const md = await fs.readFile(path.join(result.runDir, 'decision.md'), 'utf8')

  assert.equal(decision.winner, 'P1')
  assert.equal(decision.electedForeman, 'a')
  assert.equal(decision.actingForeman, 'b')
  assert.equal(decision.failover, true)
  assert.equal(decision.fallback, false)
  assert.equal(decision.vetoFrozen, true)
  assert.equal(decision.buildGate.status, 'passed')
  assert.equal(decision.ownerGate, true)
  assert.equal(decision.canBuild, false)
  assert.deepEqual(decision.adopt, ['P1'])
  assert.equal(decision.veto.length, 0)
  assert.equal(votes.foreman, 'a')
  assert.equal(votes.actingForeman, 'b')
  assert.equal(meta.electedForeman, 'a')
  assert.equal(meta.actingForeman, 'b')
  assert.match(md, /FAILOVER/)
  assert.match(md, /Veto power:\*\* frozen/)
  console.log('PASS failover keeps elected proposal, freezes veto, and records elected/acting')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
