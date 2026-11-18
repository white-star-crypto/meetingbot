#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-vault-'))
process.env.MEETINGBOT_VAULT_DIR = tmp
const vault = await import('../src/key-vault.mjs?fence=' + Date.now())
try {
  vault.putSecret('alpha', 'secret-one')
  assert.equal(vault.getSecret('alpha'), 'secret-one')
  const rotated = vault.rotateMaster()
  assert.equal(rotated.rotated, 1)
  assert.equal(vault.getSecret('alpha'), 'secret-one')

  const master = path.join(tmp, 'providers.vault.key')
  await fs.writeFile(master, 'not-a-valid-master-key', 'utf8')
  assert.throws(() => vault.putSecret('beta', 'secret-two'), /master key is corrupt/)
  assert.equal(vault.getSecret('alpha'), '')

  await fs.writeFile(master, Buffer.alloc(32, 7).toString('base64') + '\n', 'utf8')
  await fs.writeFile(path.join(tmp, 'providers.vault.json'), '{broken', 'utf8')
  const before = await fs.readFile(path.join(tmp, 'providers.vault.json'), 'utf8')
  assert.throws(() => vault.putSecret('beta', 'secret-two'), /vault file is corrupt/)
  assert.equal(await fs.readFile(path.join(tmp, 'providers.vault.json'), 'utf8'), before)
  console.log('PASS key vault: corrupt master/vault refuses overwrite, no silent key loss')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
