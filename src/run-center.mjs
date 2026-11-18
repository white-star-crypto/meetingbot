import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

export async function listRuns({ dataRoot = resolveDataRoot(), limit = 40 } = {}) {
  const rows = []
  for (const folder of ['runs', 'runs-live']) {
    const root = path.join(dataRoot, folder)
    let names = []
    try { names = await fs.readdir(root) } catch { continue }
    for (const name of names) {
      const dir = path.join(root, name)
      try {
        const stat = await fs.stat(dir)
        if (!stat.isDirectory()) continue
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}'))
        const hasDecision = await fs.stat(path.join(dir, 'decision.json')).then(() => true).catch(() => false)
        rows.push({
          id: meta.runId || name,
          folder,
          path: dir,
          createdAt: meta.createdAt || stat.mtime.toISOString(),
          mode: meta.mode || (folder === 'runs-live' ? 'live' : 'meeting'),
          brief: String(meta.brief || '').split(/[\\/]/).pop() || '',
          // Participants, not the size of the roster file: a 17-model roster
          // with 2 selected models is a 2-model meeting.
          models: Array.isArray(meta.selected) && meta.selected.length
            ? meta.selected.length
            : (Array.isArray(meta.selection?.agents) && meta.selection.agents.length
              ? meta.selection.agents.length
              : (Array.isArray(meta.roster) ? meta.roster.length : 0)),
          promptTokens: Number.isFinite(Number(meta.usage?.promptTokens)) ? Number(meta.usage.promptTokens) : null,
          completionTokens: Number.isFinite(Number(meta.usage?.completionTokens)) ? Number(meta.usage.completionTokens) : null,
          status: hasDecision ? 'completed' : (folder === 'runs-live' ? 'running-or-incomplete' : 'incomplete'),
          parentRunId: meta.parentRunId || null,
          promptTokensKnown: Number.isFinite(Number(meta.usage?.promptTokens)),
          completionTokensKnown: Number.isFinite(Number(meta.usage?.completionTokens)),
        })
      } catch { /* skip a partially-written run */ }
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const row of rows) {
    let attempt = 1, cursor = row.parentRunId, guard = 0
    while (cursor && byId.has(cursor) && guard++ < 50) { attempt++; cursor = byId.get(cursor).parentRunId }
    row.attempt = attempt
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(1, Math.min(200, Number(limit) || 40)))
}
