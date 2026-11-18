#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runMeeting } from '../src/meeting.mjs'

let calls = 0
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    calls++
    let messages = []
    try { messages = JSON.parse(body).messages || [] } catch { /* empty */ }
    const system = String(messages.find((message) => message.role === 'system')?.content || '')
    let content
    if (/independent participant/i.test(system)) {
      content = JSON.stringify({ understanding: 'understand', architecture: 'arch', aesthetic: 'visual', risks: ['risk'], confidence: 0.8, summary: 'summary' })
    } else if (/reviewer in a cross-debate/i.test(system)) {
      content = JSON.stringify({ critiques: { P1: { architecture: 'a', aesthetics: 'v', security: 's', keep: 'k' }, P2: { architecture: 'a2', aesthetics: 'v2', security: 's2', keep: 'k2' } }, best_aesthetic: 'P1', summary: 'ok' })
    } else if (/voter after a cross-debate/i.test(system)) {
      content = JSON.stringify({ vote_for: 'P1', scores: { P1: { architecture: 9, aesthetics: 9, security: 9 }, P2: { architecture: 7, aesthetics: 7, security: 7 } }, ranking: ['P1', 'P2'], reason: 'better' })
    } else {
      content = JSON.stringify({ adopt: ['P1'], veto: [], merge_plan: 'merge', risks: [], build_tasks: ['task'], code_structure: { modules: ['m'], flow: ['f'] }, rationale: 'r' })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
})

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-cache-meeting-'))
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const { port } = fake.address()
const configPath = path.join(tmp, 'config.json')
const briefPath = path.join(tmp, 'brief.md')
await fs.writeFile(briefPath, '# Cache test\n\nBuild a tiny page.\n', 'utf8')
await fs.writeFile(configPath, JSON.stringify({
  name: 'cache-test',
  participants: ['a', 'b'].map((id, index) => ({
    id,
    label: id.toUpperCase(),
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: `mock-${index}`,
    apiKey: 'test',
    enabled: true,
    tags: index === 0 ? ['code'] : ['design'],
    costTier: 1,
    qualityTier: 1,
  })),
  selection: { count: 2 },
  quorum: { min: 2 },
  minSuccessfulProposals: 2,
  buildGate: { required: false },
  cache: { enabled: true, dir: path.join(tmp, 'cache') },
}), 'utf8')

try {
  const first = await runMeeting({ briefPath, configPath, outDir: path.join(tmp, 'runs'), cacheDir: path.join(tmp, 'cache') })
  const firstCalls = calls
  assert.ok(firstCalls >= 6, `expected live calls, got ${firstCalls}`)
  const second = await runMeeting({ briefPath, configPath, outDir: path.join(tmp, 'runs'), cacheDir: path.join(tmp, 'cache') })
  assert.equal(second.decision.winner, first.decision.winner)
  assert.ok(second.cache?.hits >= 6, `expected cached hits, got ${second.cache?.hits}`)
  assert.equal(calls, firstCalls, 'second run must not call the provider')
  console.log(`PASS live stage cache: ${firstCalls} provider calls, ${second.cache.hits} cache hits`)
} finally {
  fake.close()
  await fs.rm(tmp, { recursive: true, force: true })
}
