// Regression tests for the session store.
//
// The panel, the CLI and a second window all share state/sessions.json. The
// first implementation kept the file in memory and rewrote it wholesale, so
// two processes silently destroyed each other's sessions. These tests pin the
// behaviour that fixed it: read before write, merge by id, write atomically.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createSessionStore } from '../src/session-store.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'heyi-sessions-'))
const file = path.join(dir, 'sessions.json')
const write = (sessions) => writeFileSync(file, JSON.stringify({ schema: 'heyi/sessions/v1', sessions }, null, 2))
const read = () => JSON.parse(readFileSync(file, 'utf8')).sessions

try {
  write([{ id: 'disk-1', title: '磁盘上已有的会话', mode: 'single', updatedAt: '2026-01-01T00:00:00.000Z' }])
  const store = createSessionStore({ statePath: file })

  assert.equal(store.list().length, 1, '启动时应读到磁盘上的会话')

  // Another process adds a session while this one is running.
  write([
    { id: 'disk-1', title: '磁盘上已有的会话', mode: 'single', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'disk-2', title: '外部新增', mode: 'meeting', updatedAt: '2026-01-02T00:00:00.000Z' },
  ])
  assert.equal(store.list().length, 2, '读取前必须重读磁盘，否则看不到别的实例写的会话')

  store.create({ title: '本实例新建' })
  const afterCreate = read().map((s) => s.id)
  assert.ok(afterCreate.includes('disk-2'), '写入必须合并磁盘上的会话，不能整份覆盖')
  assert.ok(afterCreate.includes('disk-1'), '写入必须保留磁盘上的会话')
  assert.equal(afterCreate.length, 3, '写入后应有三条会话')

  // The other process edits a session with a newer timestamp.
  write([
    { id: 'disk-1', title: '外部改过的标题', mode: 'single', updatedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'disk-2', title: '外部新增', mode: 'meeting', updatedAt: '2026-01-02T00:00:00.000Z' },
  ])
  assert.equal(store.get('disk-1').title, '外部改过的标题', '重读应看到外部较新的版本')
  const localUpdate = store.update('disk-1', { title: '本实例明确改过的标题' })
  assert.ok(localUpdate, '外部版本较新时，本实例的显式 update 不应静默 no-op')
  assert.equal(localUpdate.title, '本实例明确改过的标题')
  const updated = read().find((s) => s.id === 'disk-1')
  assert.equal(updated.title, '本实例明确改过的标题', '显式更新必须真正写盘')

  assert.ok(existsSync(file.replace(/\.json$/, '.json.bak')), '必须保留一份可回落的备份')

  // A half-written file must not take the whole history down.
  writeFileSync(file, '{ broken json')
  assert.ok(store.list().length >= 1, '主文件损坏时应从备份回落')

  // Retention only touches sessions the user already archived.
  write([
    { id: 'old-archived', archived: true, updatedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'old-active', archived: false, updatedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'new-archived', archived: true, updatedAt: '2999-01-01T00:00:00.000Z' },
  ])
  const removed = store.purgeArchivedOlderThan(30)
  const left = read().map((s) => s.id)
  assert.equal(removed, 1, '只应清理过期的归档会话')
  assert.ok(left.includes('old-active'), '未归档的会话不受保留策略影响')
  assert.ok(left.includes('new-archived'), '未到期的归档会话应保留')

  // A stale second instance must not resurrect a session deleted by the first.
  const a = createSessionStore({ statePath: file })
  const b = createSessionStore({ statePath: file })
  const doomed = a.create({ title: 'delete me across instances' })
  assert.ok(b.list().some((s) => s.id === doomed.id))
  a.remove(doomed.id)
  b.create({ title: 'a later write from the stale instance' })
  assert.equal(read().some((s) => s.id === doomed.id), false, 'tombstone must survive a stale merge')

  console.log('PASS session store (merge / atomic write / backup / retention)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
