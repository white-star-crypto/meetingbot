import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

const DEFAULTS = Object.freeze({ schemaVersion: 1, workspaceCommon: null, workspaceCommonOpen: true, workspaceMoreOpen: false, toolSplitOpen: false, toolId: 'browser' })

export function createPreferencesStore({ dataRoot = resolveDataRoot() } = {}) {
  const file = path.join(dataRoot, 'state', 'preferences.json')
  let state = null
  const load = async () => {
    if (state) return state
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      state = { ...DEFAULTS, ...parsed }
    } catch (error) {
      if (error?.code === 'ENOENT') state = { ...DEFAULTS }
      else throw new Error('preferences file is unreadable or corrupt')
    }
    return state
  }
  return {
    async get() { return { ...(await load()) } },
    async patch(patch = {}) {
      const current = await load()
      if (Array.isArray(patch.workspaceCommon)) current.workspaceCommon = patch.workspaceCommon.map(String).slice(0, 50)
      for (const key of ['workspaceCommonOpen', 'workspaceMoreOpen', 'toolSplitOpen']) {
        if (typeof patch[key] === 'boolean') current[key] = patch[key]
      }
      if (typeof patch.toolId === 'string') current.toolId = patch.toolId.slice(0, 40)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8')
      await fs.rename(tmp, file)
      return { ...current }
    },
  }
}
