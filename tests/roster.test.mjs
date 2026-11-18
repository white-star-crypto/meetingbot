#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { createRosterStore } from '../src/roster-store.mjs'

const dir = await mkdtemp(join(tmpdir(), 'heyi-roster-'))
try {
  const participants = [
    ['ds-flash', 'DeepSeek V4.1 Flash', 'deepseek-flash'],
    ['glm-flash', 'GLM-5.3 Flash', 'glm-5.3-flash'],
    ['mimo-flash', 'MiMo V2.6 Flash', 'mimo-v2.6-flash'],
    ['qwen-flash', 'Qwen3.8 Flash', 'qwen3.8-flash'],
    ['wenxin-51', 'ERNIE 5.1', 'ernie-5.1'],
    ['doubao-turbo', 'Doubao Seed 2.1 Turbo', 'doubao-seed-2-1-turbo-260628'],
    ['minimax-flash', 'MiniMax M3.1 Flash', 'MiniMax-M3.1-Flash'],
  ].map(([id, label, model]) => ({ id, label, model, apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', provider: 'openai' }))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    name: 'roster-test',
    selection: { count: 2, defaultPreset: 'one' },
    presets: { one: { label: 'DeepSeek + MiMo', agents: ['ds-flash', 'mimo-flash'], thinking: 'high' } },
    quorum: { min: 2 },
    participants,
  }, null, 2), 'utf8')
  const config = loadConfig(configPath, { requireKeys: false })
  const statePath = join(dir, 'state', 'roster.json')
  const store = createRosterStore({ config, statePath })
  const initial = store.state()
  assert.equal(initial.models.length, 7, 'canonical seven models')
  assert.deepEqual(initial.selected, ['ds-flash', 'mimo-flash'])
  assert.equal(initial.presets.one.agents.length, 2)

  const updated = store.update({
    name: '七模型评审',
    selected: ['ds-flash', 'glm-flash', 'qwen-flash'],
    thinking: { 'ds-flash': 'max', 'glm-flash': 'high' },
    pinnedModels: ['ds-flash'],
    pinnedPresets: ['one'],
    workMode: 'division',
  })
  assert.equal(updated.name, '七模型评审')
  assert.deepEqual(updated.selected, ['ds-flash', 'glm-flash', 'qwen-flash'])
  assert.equal(updated.thinking['ds-flash'], 'max')
  assert.equal(updated.workMode, 'division')

  const reloaded = createRosterStore({ config, statePath })
  assert.deepEqual(reloaded.state().selected, ['ds-flash', 'glm-flash', 'qwen-flash'])
  assert.equal(reloaded.state().name, '七模型评审')
  const selection = reloaded.meetingSelection({ workMode: 'ondemand' })
  assert.deepEqual(selection.agents, ['ds-flash', 'glm-flash', 'qwen-flash'])
  assert.equal(selection.workMode, 'ondemand')
  assert.equal(selection.thinking['ds-flash'], 'max')

  console.log('PASS single roster store')
} finally {
  await rm(dir, { recursive: true, force: true })
}
