#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runMeeting } from '../src/meeting.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-foreman-fail-'))
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = body.messages?.map((m) => m.content).join('\n') || ''
  const model = body.model
  let content
  let finishReason = 'stop'
  if (prompt.includes('independent participant')) {
    const id = model === 'model-a' ? 'P1' : model === 'model-b' ? 'P2' : 'P3'
    content = JSON.stringify({
      understanding: `understanding ${id}`,
      architecture: `architecture ${id}`,
      aesthetic: `aesthetic ${id}`,
      risks: [],
      confidence: 0,
      summary: `summary ${id}`,
    })
  } else if (prompt.includes('reviewer in a cross-debate')) {
    content = JSON.stringify({
      critiques: {
        P1: null,
        P2: { architecture: 'a2', aesthetics: 'v2', security: 's2', keep: 'k2' },
        P3: 'not-an-object',
      },
      best_aesthetic: 'P2',
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
      reason: 'P1',
    })
  } else {
    content = '{"adopt":["P1"]}'
    finishReason = 'length'
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(path.join(dir, 'brief.md'), 'All foremen fail.\n', 'utf8')
  await fs.writeFile(configPath, JSON.stringify({
    name: 'foreman-failure',
    maxTokens: 800,
    timeoutMs: 5000,
    selection: { count: 3, maxCostTier: 5 },
    quorum: { min: 2 },
    decision: { maxVetoes: 1 },
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
  }), 'utf8')

  const result = await runMeeting({ briefPath: path.join(dir, 'brief.md'), configPath, outDir: path.join(dir, 'runs'), selection: { agents: ['a', 'b', 'c'] } })
  const decision = JSON.parse(await fs.readFile(path.join(result.runDir, 'decision.json'), 'utf8'))
  const firstProposal = JSON.parse(await fs.readFile(path.join(result.runDir, 'proposals', 'P1.json'), 'utf8'))
  assert.equal(firstProposal.confidence, 0)
  const md = await fs.readFile(path.join(result.runDir, 'decision.md'), 'utf8')
  const html = await fs.readFile(path.join(result.runDir, 'report.html'), 'utf8')
  assert.equal(decision.actingForeman, null)
  assert.equal(decision.foreman, null)
  assert.equal(decision.electedForeman, 'a')
  assert.equal(decision.fallback, true)
  assert.equal(decision.ownerGate, true)
  assert.equal(decision.canBuild, false)
  assert.match(md, /Acting foreman.*none/)
  assert.match(html, /Acting none/)

  console.log('PASS all foremen fail: no fake acting foreman; reports render; null critiques do not crash')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
