import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

const text = (value, max = 4000) => String(value ?? '').trim().slice(0, max)

export function createMemoryStore({ dataRoot = resolveDataRoot(), statePath = '' } = {}) {
  const file = statePath ? path.resolve(statePath) : path.join(dataRoot, 'state', 'memory.json')
  let entries = null
  const load = async () => {
    if (entries) return entries
    try {
      entries = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') entries = []
      else throw new Error('memory file is unreadable or corrupt; refusing to overwrite it')
    }
    if (!Array.isArray(entries)) throw new Error('memory file must contain a JSON array')
    return entries
  }
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    if (entries.length > 5000) throw new Error('memory capacity exceeded (5000); export and prune before adding more')
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }
  const add = async (input, source = 'owner') => {
    const value = text(input?.text ?? input, 4000)
    if (!value) throw new Error('memory text required')
    await load()
    const entry = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: text(input?.title, 120) || text(value.split('\n')[0], 60),
      text: value,
      kind: ['note', 'knowledge', 'skill', 'decision'].includes(input?.kind) ? input.kind : 'knowledge',
      tags: Array.isArray(input?.tags) ? input.tags.map((tag) => text(tag, 30)).filter(Boolean).slice(0, 8) : [],
      status: ['pending', 'rejected'].includes(input?.status) ? input.status : 'approved',
      core: input?.core === true && (input?.status === undefined || input?.status === 'approved'),
      source: text(source, 120) || 'owner',
      at: new Date().toISOString(),
    }
    entries.push(entry)
    await save()
    return entry
  }
  const update = async (id, patch = {}) => {
    await load()
    const entry = entries.find((row) => row.id === String(id))
    if (!entry) throw new Error('memory entry not found')
    if (patch.title !== undefined) entry.title = text(patch.title, 120) || entry.title
    if (patch.text !== undefined) {
      const value = text(patch.text, 4000)
      if (!value) throw new Error('memory text required')
      entry.text = value
    }
    if (patch.status === 'pending' || patch.status === 'approved' || patch.status === 'rejected') { entry.status = patch.status; if (patch.status !== 'approved') entry.core = false }
    if (patch.core !== undefined) { if (patch.core === true && entry.status !== 'approved') throw new Error('memory must be approved before it can be core'); entry.core = patch.core === true }
    if (Array.isArray(patch.tags)) entry.tags = patch.tags.map((tag) => text(tag, 30)).filter(Boolean).slice(0, 8)
    if (patch.kind !== undefined && ['note', 'knowledge', 'skill', 'decision'].includes(patch.kind)) entry.kind = patch.kind
    await save()
    return entry
  }
  return {
    async list() { return [...(await load())] },
    add,
    async approve(id) { return update(id, { status: 'approved' }) },
    async reject(id) { return update(id, { status: 'rejected' }) },
    async update(id, patch) { return update(id, patch) },
    async remove(id) {
      await load()
      const before = entries.length
      entries = entries.filter((entry) => entry.id !== String(id))
      await save(); return before !== entries.length
    },
  }
}
