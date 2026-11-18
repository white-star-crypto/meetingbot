import fs from 'node:fs'
import path from 'node:path'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function defaultState() {
  return { schema: 'heyi/sessions/v1', sessions: [], tombstones: {} }
}

// A session file is shared by every process that opens this app (the panel
// server, a second window, the CLI). Writing it as "my in-memory array"
// silently destroyed whatever another process had saved, so every write now
// re-reads the file, merges by id, and replaces the file atomically.
export function createSessionStore({ statePath, onError = null }) {
  const file = path.resolve(statePath)
  const backupFile = file.replace(/\.json$/, '') + '.json.bak'
  const tmpFile = file.replace(/\.json$/, '') + '.json.tmp'

  const readFile = (target) => {
    try {
      const raw = fs.readFileSync(target, 'utf8').replace(/^﻿/, '')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.sessions)) return { schema: 'heyi/sessions/v1', sessions: parsed.sessions, tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : {} }
    } catch { /* fall through */ }
    return null
  }

  // A half-written file is a real risk when the process dies mid-write, so a
  // previous good copy is kept and used when the main file cannot be parsed.
  const readDisk = () => {
    const main = readFile(file)
    if (main) return main
    const backup = readFile(backupFile)
    if (backup) return backup
    return defaultState()
  }

  let state = readDisk()
  if (!fs.existsSync(file)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
      fs.renameSync(tmpFile, file)
    } catch { /* the directory may not exist yet; the first write will retry */ }
  }

  const lockFile = file + '.lock'
  const withLock = (fn) => {
    let handle = null
    const started = Date.now()
    while (!handle) {
      try {
        handle = fs.openSync(lockFile, 'wx')
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          if (age > 2000) fs.unlinkSync(lockFile)
        } catch { /* another process may have released it */ }
        if (Date.now() - started > 5000) throw new Error('session store lock timeout')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try { return fn() } finally {
      try { fs.closeSync(handle) } catch { /* ignore */ }
      try { fs.unlinkSync(lockFile) } catch { /* ignore */ }
    }
  }

  const mergeStates = (disk) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const tombstones = { ...(disk?.tombstones || {}), ...(state.tombstones || {}) }
    for (const [id, at] of Object.entries(tombstones)) {
      const parsed = Date.parse(String(at || ''))
      if (Number.isFinite(parsed) && parsed < cutoff) delete tombstones[id]
    }
    const merged = new Map()
    for (const s of disk?.sessions || []) merged.set(s.id, s)
    for (const s of state.sessions) {
      const other = merged.get(s.id)
      if (!other || String(s.updatedAt || '') >= String(other.updatedAt || '')) merged.set(s.id, s)
    }
    const sessions = [...merged.values()].filter((session) => {
      const deletedAt = tombstones[session.id]
      return !deletedAt || String(session.updatedAt || '') > String(deletedAt)
    })
    return { schema: 'heyi/sessions/v1', sessions, tombstones }
  }

  const persist = () => withLock(() => {
    const disk = readDisk()
    state = mergeStates(disk)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = JSON.stringify(state, null, 2) + '\n'
      fs.writeFileSync(tmpFile, payload, 'utf8')
      // Keep the last good copy before replacing the live file.
      try { fs.copyFileSync(file, backupFile) } catch { /* first write */ }
      fs.renameSync(tmpFile, file)
    } catch (error) {
      try { onError?.(error) } catch { /* audit must not break the store */ }
    }
  })

  const find = (id) => state.sessions.find((s) => s.id === id)

  const publicSession = (s) => {
    if (!s) return null
    const copy = clone(s)
    if (Array.isArray(copy.messages) && copy.messages.length > 40) {
      copy.messagesTruncated = true
      copy.messages = copy.messages.slice(-40)
    }
    return copy
  }

  // Another process may have added or removed sessions since we loaded the
  // file; tombstones make deletes survive a stale writer's merge.
  const reload = () => {
    state = mergeStates(readDisk())
    return state
  }

  return {
    list({ includeArchived = true } = {}) {
      reload()
      const rows = state.sessions
        .filter((s) => includeArchived || !s.archived)
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return rows.map((s) => {
        const { messages, ...meta } = s
        return { ...meta, messageCount: Array.isArray(messages) ? messages.length : 0 }
      })
    },
    get(id) {
      reload()
      return publicSession(find(id))
    },
    create(input = {}) {
      reload()
      const now = new Date().toISOString()
      const session = {
        id: String(input.id || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
        title: String(input.title || '未命名会话').slice(0, 120),
        mode: input.mode === 'single' ? 'single' : 'meeting',
        workMode: ['council', 'division', 'ondemand'].includes(input.workMode) ? input.workMode : 'council',
        project: String(input.project || '').slice(0, 80),
        pinned: !!input.pinned,
        archived: !!input.archived,
        createdAt: input.createdAt || now,
        updatedAt: now,
        brief: String(input.brief || '').slice(0, 20000),
        runDir: String(input.runDir || '').slice(0, 500),
        executionIntent: input.executionIntent === 'decide' ? 'decide' : 'execute',
        messages: Array.isArray(input.messages) ? input.messages.slice(-200) : [],
        decision: input.decision || null,
        proposals: Array.isArray(input.proposals) ? input.proposals.slice(0, 20) : [],
        meta: String(input.meta || '').slice(0, 200),
      }
      state.sessions.unshift(session)
      delete state.tombstones[session.id]
      persist()
      return publicSession(session)
    },
    update(id, patch = {}) {
      reload()
      const session = find(id)
      if (!session) return null
      const allowed = ['title', 'mode', 'workMode', 'project', 'pinned', 'archived', 'brief', 'decision', 'proposals', 'meta', 'runDir', 'executionIntent']
      for (const key of allowed) {
        if (patch[key] !== undefined) {
          session[key] = key === 'executionIntent'
            ? (patch[key] === 'decide' ? 'decide' : 'execute')
            : (key === 'title' || key === 'project' || key === 'meta' ? String(patch[key]).slice(0, 200) : (key === 'runDir' ? String(patch[key]).slice(0, 500) : (key === 'workMode' && !['council','division','ondemand'].includes(patch[key]) ? session.workMode : patch[key])))
        }
      }
      if (patch.messages !== undefined) session.messages = Array.isArray(patch.messages) ? patch.messages.slice(-200) : session.messages
      session.updatedAt = new Date().toISOString()
      persist()
      return publicSession(session)
    },
    appendMessage(id, message) {
      reload()
      const session = find(id)
      if (!session) return null
      if (!Array.isArray(session.messages)) session.messages = []
      session.messages.push({
        role: String(message.role || 'system').slice(0, 20),
        name: String(message.name || '').slice(0, 80),
        content: String(message.content || '').slice(0, 8000),
        at: message.at || new Date().toISOString(),
      })
      if (session.messages.length > 200) session.messages = session.messages.slice(-200)
      session.updatedAt = new Date().toISOString()
      persist()
      return { ok: true, count: session.messages.length }
    },
    remove(id) {
      reload()
      const index = state.sessions.findIndex((s) => s.id === id)
      if (index < 0) return false
      state.sessions.splice(index, 1)
      state.tombstones[id] = new Date().toISOString()
      persist()
      return true
    },
    clear() {
      reload()
      const now = new Date().toISOString()
      for (const session of state.sessions) state.tombstones[session.id] = now
      state.sessions = []
      persist()
      return true
    },
    archiveAll() {
      // Recoverable "clear": nothing is removed, so the UI can restore items.
      reload()
      const now = new Date().toISOString()
      let changed = 0
      for (const session of state.sessions) {
        if (!session.archived) { session.archived = true; session.updatedAt = now; changed++ }
      }
      if (changed) persist()
      return changed
    },
    // Retention policy for archived sessions. Only sessions the user already
    // archived are eligible, and the removal is reported so the UI can say
    // exactly what happened.
    purgeArchivedOlderThan(days) {
      const keep = Number(days)
      if (!Number.isFinite(keep) || keep <= 0) return 0
      reload()
      const cutoff = Date.now() - keep * 24 * 60 * 60 * 1000
      const before = state.sessions.length
      state.sessions = state.sessions.filter((s) => {
        if (!s.archived) return true
        const ts = Date.parse(s.updatedAt || s.createdAt || '')
        return !(Number.isFinite(ts) && ts < cutoff)
      })
      const removed = before - state.sessions.length
      if (removed) persist()
      return removed
    },
    file,
  }
}
