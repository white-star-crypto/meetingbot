import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

export function createCompareHistoryStore({ dataRoot = resolveDataRoot(), statePath = '' } = {}) {
  const file = statePath ? path.resolve(statePath) : path.join(dataRoot, 'state', 'compare-history.json')
  let rows = null
  const load = async () => {
    if (rows) return rows
    try { rows = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') rows = []; else throw new Error('compare history is unreadable or corrupt') }
    if (!Array.isArray(rows)) throw new Error('compare history must be an array')
    return rows
  }
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(rows.slice(0, 50), null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }
  return {
    async list() { return [...(await load())] },
    async add(input) {
      const prompt = String(input?.prompt || '').trim().slice(0, 4000)
      if (!prompt) throw new Error('prompt required')
      await load()
      const row = { id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), prompt, results: Array.isArray(input?.results) ? input.results : [], merge: String(input?.merge || '') }
      rows.unshift(row); rows = rows.slice(0, 50); await save(); return row
    },
  }
}
