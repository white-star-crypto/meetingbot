#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { compareModels } from '../src/compare.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-compare-'))
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const prompt = String(JSON.parse(body || '{}').messages?.at(-1)?.content || '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'answer:' + prompt.slice(0, 12) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const port = server.address().port
  const base = JSON.parse(await fs.readFile('examples/config.mock.json', 'utf8'))
  const config = {
    ...base,
    roster: base.roster.slice(0, 2).map((entry, index) => ({
      ...entry,
      id: `m${index}`,
      label: `Model ${index}`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
    })),
  }
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8')
  const result = await compareModels({ configPath, prompt: 'compare this', agentIds: ['m0', 'm1'] })
  assert.equal(result.results.length, 2)
  assert.ok(result.results.every((item) => item.ok))
  assert.match(result.results[0].content, /answer:/)
  const merged = await compareModels({ configPath, prompt: 'compare this', agentIds: ['m0', 'm1'], merge: true, mergeAgentId: 'm0' })
  assert.ok(merged.merge?.ok)
  console.log('PASS compare: parallel answers plus merged answer')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
