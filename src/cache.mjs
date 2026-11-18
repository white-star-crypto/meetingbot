import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

const SCHEMA = 'meetingbot/stage-cache/v1'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function stageCacheKey({ phase, participant, messages, settings }) {
  return hash({
    schema: SCHEMA,
    phase: String(phase || ''),
    agent: {
      id: participant?.id || '',
      model: participant?.model || '',
      baseUrl: participant?.baseUrl || '',
      provider: participant?.provider || '',
      reasoningEffort: participant?.reasoningEffort || '',
      noThink: participant?.noThink === true,
      jsonMode: participant?.jsonMode === true,
      temperature: participant?.temperature ?? null,
    },
    limits: {
      maxTokens: Number(settings?.maxTokens) || 0,
      temperature: Number(settings?.temperature) || 0,
    },
    messages,
  })
}

export function createStageCache({ dir, enabled = true, ttlMs = DEFAULT_TTL_MS } = {}) {
  const root = path.resolve(dir || path.join(resolveDataRoot(), 'state', 'cache'))
  const ttl = Math.max(60 * 1000, Math.min(90 * 24 * 60 * 60 * 1000, Number(ttlMs) || DEFAULT_TTL_MS))
  let hits = 0
  let misses = 0
  let writes = 0

  const fileFor = (key) => path.join(root, `${key}.json`)

  async function get(key) {
    if (!enabled) return null
    try {
      const file = fileFor(key)
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      if (raw?.schema !== SCHEMA || raw.expiresAt < Date.now() || !raw.response) {
        misses++
        if (raw?.expiresAt < Date.now()) await fs.unlink(file).catch(() => {})
        return null
      }
      hits++
      return { ...raw.response, cached: true, durationMs: 0, usage: null }
    } catch {
      misses++
      return null
    }
  }

  async function set(key, response) {
    if (!enabled || !response || typeof response.content !== 'string' || !response.content.trim()) return
    if (['length', 'max_tokens'].includes(String(response.finishReason || '').toLowerCase())) return
    try {
      await fs.mkdir(root, { recursive: true })
      const file = fileFor(key)
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await fs.writeFile(tmp, JSON.stringify({
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + ttl,
        response: {
          content: response.content,
          finishReason: response.finishReason || null,
        },
      }, null, 2) + '\n', 'utf8')
      await fs.rename(tmp, file)
      writes++
    } catch { /* cache is best-effort, never a meeting failure */ }
  }

  function stats() {
    return { enabled, hits, misses, writes, dir: root }
  }

  return { get, set, stats }
}
