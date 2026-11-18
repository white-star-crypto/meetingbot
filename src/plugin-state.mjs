import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

export const OFFICIAL_PLUGINS = [
  { id: 'compare', name: '对照' },
  { id: 'memory', name: '记忆库' },
  { id: 'runs', name: 'Run Center' },
  { id: 'jobs', name: '后台任务' },
  { id: 'executor', name: '合议执行器', defaultEnabled: false },
  { id: 'companion', name: '副屏', defaultEnabled: false },
  { id: 'ontology', name: '决策本体', defaultEnabled: true },
  { id: 'anidoodle', name: 'anidoodle', defaultEnabled: false },
]

export function createPluginStateStore({ dataRoot = resolveDataRoot() } = {}) {
  const file = path.join(dataRoot, 'state', 'plugins.json')
  let state = null
  const defaults = () => ({ schemaVersion: 1, officials: Object.fromEntries(OFFICIAL_PLUGINS.map((p) => [p.id, p.defaultEnabled !== false])), thirdParty: {} })
  const load = async () => {
    if (state) return state
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      state = { ...defaults(), ...parsed, officials: { ...defaults().officials, ...(parsed.officials || {}) }, thirdParty: { ...(parsed.thirdParty || {}) } }
    } catch (error) {
      if (error?.code === 'ENOENT') state = defaults()
      else throw new Error('plugin state is unreadable or corrupt')
    }
    return state
  }
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }
  return {
    async list() {
      const current = await load()
      return OFFICIAL_PLUGINS.map((plugin) => ({ ...plugin, official: true, enabled: current.officials[plugin.id] !== undefined ? current.officials[plugin.id] !== false : plugin.defaultEnabled !== false, uninstallable: false }))
    },
    async isEnabled(id) {
      const current = await load()
      return current.officials[id] !== undefined ? current.officials[id] !== false : (OFFICIAL_PLUGINS.find((p) => p.id === id)?.defaultEnabled !== false)
    },
    async setOfficial(id, enabled) {
      if (!OFFICIAL_PLUGINS.some((plugin) => plugin.id === id)) throw new Error('unknown official plugin')
      const current = await load()
      current.officials[id] = enabled === true
      await save()
      return { id, enabled: current.officials[id] }
    },
    async listThirdParty() { const current = await load(); return Object.values(current.thirdParty || {}) },
    // Third-party rows are an index, never code. Metadata is kept so a submission
    // survives a restart with its description and preview intact.
    async registerThirdParty(id, data = {}) {
      const current = await load()
      const key = String(id)
      const existing = current.thirdParty[key] || {}
      const row = {
        id: key,
        name: String(data.name || existing.name || key).slice(0, 120),
        url: String(data.url || existing.url || '').slice(0, 400),
        enabled: data.enabled !== undefined ? data.enabled === true : existing.enabled !== false,
        source: String(data.source || existing.source || 'third-party').slice(0, 40),
        owner: String(data.owner || existing.owner || '').slice(0, 120),
        description: String(data.description || existing.description || '').slice(0, 2000),
        preview: String(data.preview || existing.preview || '').slice(0, 600),
        submitted: data.submitted === true || existing.submitted === true,
        at: existing.at || new Date().toISOString(),
      }
      current.thirdParty[key] = row
      await save()
      return row
    },
    async setThirdPartyEnabled(id, enabled) { const current = await load(); const row = current.thirdParty[String(id)]; if (!row) throw new Error('third-party plugin not registered'); row.enabled = enabled === true; await save(); return row },
    async removeThirdParty(id) { const current = await load(); const key = String(id); const existed = Boolean(current.thirdParty[key]); delete current.thirdParty[key]; await save(); return existed },
    async uninstall(id) {
      if (OFFICIAL_PLUGINS.some((plugin) => plugin.id === id)) throw new Error('official plugins cannot be uninstalled')
      throw new Error('unknown plugin')
    },
  }
}
