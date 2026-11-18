#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStageCache, stageCacheKey } from '../src/cache.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-cache-'))
const participant = { id: 'p1', model: 'm1', baseUrl: 'http://example.invalid/v1', provider: 'openai' }
const settings = { maxTokens: 1000, temperature: 0.2 }
const messages = [{ role: 'user', content: 'same prompt' }]
try {
  const cache = createStageCache({ dir: tmp, ttlMs: 60000 })
  const key = stageCacheKey({ phase: 'proposal', participant, messages, settings })
  assert.equal(await cache.get(key), null)
  await cache.set(key, { content: '{"ok":true}', finishReason: 'stop' })
  const hit = await cache.get(key)
  assert.equal(hit.content, '{"ok":true}')
  assert.equal(hit.cached, true)
  assert.equal(hit.usage, null)
  assert.equal(hit.durationMs, 0)
  const changed = stageCacheKey({ phase: 'critique', participant, messages, settings })
  assert.equal(await cache.get(changed), null)
  const modelChanged = stageCacheKey({ phase: 'proposal', participant: { ...participant, model: 'm2' }, messages, settings })
  const temperatureChanged = stageCacheKey({ phase: 'proposal', participant: { ...participant, temperature: 0.9 }, messages, settings })
  assert.equal(await cache.get(modelChanged), null)
  assert.equal(await cache.get(temperatureChanged), null)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.ok(stats.writes >= 1)
  console.log('PASS stage cache hit/miss, prompt/model/phase/temperature invalidation, stats')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
