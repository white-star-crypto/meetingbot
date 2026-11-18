import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

process.env.DEEPSEEK_API_KEY = 'sk-alias-test'
process.env.DASHSCOPE_API_KEY = 'sk-alias-test-qwen'
// Keep the test independent from the user's real encrypted vault.
const isolatedVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyi-alias-vault-'))
process.env.MEETINGBOT_VAULT_DIR = isolatedVaultDir

const { loadConfig, selectParticipants, publicRoster } = await import('../src/config.mjs')
const { canonicalModelId, canonicalParticipants, resolveParticipant } = await import('../src/model-aliases.mjs')
const { createRosterStore } = await import('../src/roster-store.mjs')

assert.equal(canonicalModelId('deepseek'), 'ds-flash')
assert.equal(canonicalModelId('deepseek-chat'), 'ds-flash')
assert.equal(canonicalModelId('glm-4.7-flash'), 'glm-flash')
assert.equal(canonicalModelId('qwen-plus'), 'qwen-flash')
assert.equal(canonicalModelId('ernie-5.1'), 'wenxin-51')
assert.equal(canonicalModelId('doubao-seed-2-1-pro-260628'), 'doubao-turbo')
assert.equal(canonicalModelId('MiniMax-M3.1-Flash'), 'minimax-flash')
assert.equal(canonicalModelId('unknown-model'), '')

const configPath = path.resolve('examples/config.example.json')
const config = loadConfig(configPath, { requireKeys: true })
assert.equal(resolveParticipant(config.participants, 'deepseek-chat').id, 'deepseek')
assert.deepEqual(selectParticipants(config, { agents: ['ds-flash', 'qwen-flash'] }).map((p) => p.id), ['deepseek', 'qwen'])
const explicit = config.participants.filter((p) => p.enabled).map((p) => p.id)
assert.equal(selectParticipants(config, { agents: explicit, requireKeys: false }).length, explicit.length, 'explicit roster must not be truncated to selection.count')
assert.equal(publicRoster(config).find((p) => p.id === 'deepseek').hasKey, true)
assert.equal(publicRoster(config).find((p) => p.id === 'glm').hasKey, false)
const labelSample = [{ id: 'glm', label: 'GLM' }, { id: 'glm4', label: 'GLM-4' }]
assert.equal(resolveParticipant(labelSample, 'GLM-4').id, 'glm4')
assert.equal(resolveParticipant(labelSample, 'GLM').id, 'glm')
assert.equal(resolveParticipant(labelSample, 'GL'), null)
const groupMembers = canonicalParticipants(config.participants, ['ds-flash', 'qwen-flash'])
assert.deepEqual(groupMembers.map((p) => p.id), ['ds-flash', 'qwen-flash'])

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heyi-alias-'))
try {
  const store = createRosterStore({ config, statePath: path.join(dir, 'roster.json') })
  const models = store.state().models
  assert.equal(models.find((m) => m.id === 'ds-flash').hasKey, true)
  assert.equal(models.find((m) => m.id === 'qwen-flash').hasKey, true)
  assert.equal(models.find((m) => m.id === 'glm-flash').hasKey, false)
  const selection = store.meetingSelection({ agents: ['ds-flash', 'qwen-flash'] })
  assert.deepEqual(selection.agents, ['ds-flash', 'qwen-flash'])
  assert.equal(selection.workMode, 'council')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(isolatedVaultDir, { recursive: true, force: true })
}

console.log('PASS canonical aliases / example config / keyed roster')
