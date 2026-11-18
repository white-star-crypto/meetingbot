#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPreferencesStore } from '../src/preferences.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-prefs-'))
try {
  const first = createPreferencesStore({ dataRoot: root })
  await first.patch({ workspaceCommon: ['council', 'runs'], workspaceCommonOpen: false, toolSplitOpen: true })
  const second = createPreferencesStore({ dataRoot: root })
  const saved = await second.get()
  assert.deepEqual(saved.workspaceCommon, ['council', 'runs'])
  assert.equal(saved.workspaceCommonOpen, false)
  assert.equal(saved.toolSplitOpen, true)
  console.log('PASS preferences: dataRoot persistence and restart reload')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
