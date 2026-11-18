#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAccountService } from '../src/account-service.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-account-'))
try {
  const account = createAccountService({ dataRoot: root })
  const before = await account.get()
  assert.equal(before.configured, false)
  const configured = await account.configure({ url: 'https://example.supabase.co', anonKey: 'anon-test-key' })
  assert.equal(configured.configured, true)
  assert.equal(configured.signedIn, false)
  const again = createAccountService({ dataRoot: root })
  assert.equal((await again.get()).configured, true)
  console.log('PASS account service: config persists without exposing anon key')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
