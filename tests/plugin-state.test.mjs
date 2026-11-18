#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPluginStateStore } from '../src/plugin-state.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-plugins-'))
try {
  const store = createPluginStateStore({ dataRoot: root })
  assert.deepEqual((await store.list()).map((p) => p.id), ['compare', 'memory', 'runs', 'jobs', 'executor', 'companion', 'ontology', 'anidoodle'])
  assert.equal(await store.isEnabled('compare'), true)
  assert.equal(await store.isEnabled('executor'), false)
  assert.equal(await store.isEnabled('companion'), false, '副屏必须默认关闭')
  assert.equal(await store.isEnabled('ontology'), true)
  assert.equal(await store.isEnabled('anidoodle'), false)
  await store.setOfficial('companion', true)
  assert.equal(await store.isEnabled('companion'), true)
  await store.setOfficial('ontology', false)
  assert.equal(await store.isEnabled('ontology'), false)
  await store.setOfficial('compare', false)
  assert.equal(await store.isEnabled('compare'), false)
  await assert.rejects(() => store.uninstall('compare'), /cannot be uninstalled/)
  await assert.rejects(() => store.setOfficial('unknown', false), /unknown official plugin/)
  await store.registerThirdParty('demo', { name: 'Demo', url: 'https://example.com' })
  assert.equal((await store.listThirdParty()).length, 1)
  await store.setThirdPartyEnabled('demo', false)
  assert.equal((await store.listThirdParty())[0].enabled, false)
  assert.equal(await store.removeThirdParty('demo'), true)
  console.log('PASS plugin state: official enable/disable and uninstall refusal')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
