#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGroupStore } from '../src/group-chat.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-group-'))
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const model = body.model
  const content = model === 'model-a' ? '安全边界要先定，否则后面的权限会返工。' : model === 'model-b' ? '页面结构可以再简单一点，先保证主路径。' : '我负责把讨论收成可验收的任务。'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  const statePath = path.join(dir, 'groups.json')
  const config = {
    maxTokens: 500,
    timeoutMs: 5000,
    participants: [
      { id: 'a', label: '安全', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'model-a', apiKey: 'k', enabled: true, tags: ['security'] },
      { id: 'b', label: '前端', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'model-b', apiKey: 'k', enabled: true, tags: ['frontend'] },
      { id: 'c', label: '收口', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'model-c', apiKey: 'k', enabled: true, tags: [] },
      { id: 'a(b', label: '括号', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'model-c', apiKey: 'k', enabled: true, tags: [] },
    ],
  }
  const store = createGroupStore({ statePath, config })
  const plan = store.plan('做一个带权限的后台，先看安全边界', [])
  assert.ok(plan.members.length >= 1)
  assert.ok(plan.members.some((m) => m.id === 'a'))

  const group = await store.create({
    name: '权限改造',
    brief: '先定安全边界，再做页面。',
    mode: 'ondemand',
    members: ['a', 'b', 'c'],
    personas: { a: '安全评审，先找权限漏洞', b: '前端实现，优先主路径', c: '收口，负责验收任务' },
  })
  assert.equal(group.members.length, 3)
  assert.equal(group.messages.length, 0)

  const ondemand = await store.send(group.id, '安全边界怎么定？')
  assert.equal(ondemand.replies.length, 1)
  assert.equal(ondemand.replies[0].agentId, 'a')
  assert.equal(ondemand.group.messages.length, 2)

  const mentioned = await store.send(group.id, '@b 页面先做哪块？')
  assert.equal(mentioned.replies.length, 1)
  assert.equal(mentioned.replies[0].agentId, 'b')

  const free = await store.send(group.id, '大家补充一下', { mode: 'free' })
  assert.equal(free.replies.length, 2)
  assert.equal(free.group.mode, 'free')

  const concurrent = await Promise.all([
    store.send(group.id, '并发问题一'),
    store.send(group.id, '并发问题二'),
  ])
  assert.equal(concurrent.length, 2)
  const finalGroup = await store.get(group.id)
  assert.ok(finalGroup.messages.filter((m) => m.role === 'user').some((m) => m.content === '并发问题一'))
  assert.ok(finalGroup.messages.filter((m) => m.role === 'user').some((m) => m.content === '并发问题二'))

  const regexGroup = await store.create({
    name: 'regex id',
    brief: 'mention a regex-looking id',
    mode: 'ondemand',
    members: ['a(b'],
  })
  const regexMention = await store.send(regexGroup.id, '@a(b hi')
  assert.equal(regexMention.replies.length, 1)
  assert.equal(regexMention.replies[0].agentId, 'a(b')
  const brief = await store.convertBrief(group.id)
  assert.match(brief, /群聊「权限改造」/)
  assert.match(brief, /匿名提案/)
  assert.equal(brief.includes('sk-'), false)

  const reloaded = createGroupStore({ statePath, config })
  const persisted = await reloaded.get(group.id)
  assert.ok(persisted)
  assert.ok(persisted.messages.length >= 6)

  console.log('PASS group chat plan/create/on-demand/@mention/free-mode/regex-id/convert/persistence')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(dir, { recursive: true, force: true })
}
