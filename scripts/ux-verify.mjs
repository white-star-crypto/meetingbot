#!/usr/bin/env node
// Cold-start verification for the UX round: boots the real panel server with a
// throwaway data root, then exercises the memory and job APIs over HTTP. This
// proves memory data stays under MeetingBot's own dataRoot/state and that the
// permission / auth gates are still fail-closed. No Electron window required.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-ux-verify-'))
process.env.MEETINGBOT_DATA_DIR = dataRoot
const { startPanel } = await import('../src/panel-server.mjs')

const results = []
const ok = (name, detail = '') => results.push(['PASS', name, detail])
let panel
try {
  panel = await startPanel({ configPath: path.join(root, 'examples', 'config.mock.json'), port: 0 })
  const base = panel.url

  const unauthenticated = await fetch(base + '/api/config')
  assert.equal(unauthenticated.status, 401)
  ok('未带会话凭证时 API 仍然 fail-closed', 'GET /api/config -> 401')

  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  const html = await page.text()
  const cookie = (page.headers.getSetCookie?.()[0] || page.headers.get('set-cookie') || '').split(';')[0]
  assert.match(cookie, /^meetingbot_session=/)
  assert.ok(html.includes('id="view-memory"'))
  assert.ok(html.includes('id="backgroundJobsPill"'))
  assert.doesNotMatch(html, /<iframe/i)
  assert.doesNotMatch(html, /7999|memory-vault|memory-eternal/)
  ok('冷启动拿到新面板且无 iframe / 7999 / DSH 记忆引用', `${html.length} bytes`)

  const api = (url, options = {}) => fetch(base + url, {
    ...options,
    headers: { cookie, ...(options.headers || {}) },
  })
  const json = async (r) => JSON.parse(await r.text())
  const post = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  let r = await api('/api/memory')
  assert.equal(r.status, 200)
  assert.deepEqual((await json(r)).entries, [])
  ok('GET /api/memory 返回独立空库')

  const created = await json(await post('/api/memory', {
    title: '输出目录约定', text: '所有报告写到 runs-live，不要写进源码目录。',
    tags: ['项目', '路径'], kind: 'decision', status: 'pending', core: false,
  }))
  assert.equal(created.ok, true)
  const card = created.entry
  for (const field of ['id', 'title', 'text', 'tags', 'kind', 'status', 'core', 'source', 'at']) {
    assert.ok(card[field] !== undefined, '知识卡缺少字段 ' + field)
  }
  assert.equal(card.status, 'pending')
  assert.equal(card.kind, 'decision')
  assert.deepEqual(card.tags, ['项目', '路径'])
  ok('新建知识卡写入完整字段并先入待审', card.id)

  const second = (await json(await post('/api/memory', { title: '临时卡', text: '待拒绝的测试卡', status: 'pending' }))).entry
  const approved = await json(await post('/api/memory', { action: 'approve', id: card.id }))
  assert.equal(approved.entry.status, 'approved')
  const cored = await json(await post('/api/memory', { action: 'update', id: card.id, patch: { core: true } }))
  assert.equal(cored.entry.core, true)
  const rejected = await json(await post('/api/memory', { action: 'reject', id: second.id }))
  assert.equal(rejected.entry.status, 'rejected')
  ok('待审通过 / 拒绝、设为核心都真实落库')

  const removed = await json(await post('/api/memory', { delete: second.id }))
  assert.equal(removed.removed, true)
  const listed = await json(await api('/api/memory'))
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].id, card.id)
  ok('删除知识卡后只剩已入库的那张')

  const memoryFile = path.join(dataRoot, 'state', 'memory.json')
  const raw = await fs.readFile(memoryFile, 'utf8')
  const onDisk = JSON.parse(raw)
  assert.equal(onDisk.length, 1)
  assert.equal(onDisk[0].title, '输出目录约定')
  assert.ok(memoryFile.startsWith(dataRoot), '记忆文件不在 MeetingBot 自己的 dataRoot 下')
  ok('记忆数据只写在 dataRoot/state/memory.json', memoryFile)

  r = await api('/api/jobs')
  assert.equal(r.status, 200)
  assert.equal((await json(r)).ok, true)
  r = await post('/api/jobs', { task: '缺少 agentId' })
  assert.equal(r.status, 400)
  r = await api('/api/jobs/does-not-exist')
  assert.equal(r.status, 404)
  ok('POST /api/jobs、GET /api/jobs、GET /api/jobs/:id 保持可用', '缺参 400 / 不存在 404')

  r = await api('/api/permissions')
  assert.equal(r.status, 200)
  const perms = await json(r)
  assert.equal(perms.permissions?.mode, 'read-only')
  ok('默认权限仍是只读', 'fail-closed')

  r = await api('/dsh-plugins.json', { method: 'HEAD' })
  assert.ok(r.status === 200 || r.status === 405, '静态插件目录不可达: ' + r.status)
  ok('本机插件目录可访问（不联网）', 'HEAD /dsh-plugins.json -> ' + r.status)

  console.log('PASS cold-start verification (' + results.length + ' checks)')
  for (const [, name, detail] of results) console.log('  - ' + name + (detail ? ' · ' + detail : ''))
} finally {
  if (panel?.server) await new Promise((resolve) => panel.server.close(resolve))
  await fs.rm(dataRoot, { recursive: true, force: true })
}
