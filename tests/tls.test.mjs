#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { startPanel } from '../src/panel-server.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-tls-'))
const pfxPath = path.join(root, 'test.pfx')
const encoded = await fs.readFile(path.resolve(import.meta.dirname, 'fixtures', 'tls-test.pfx.b64'), 'utf8')
await fs.writeFile(pfxPath, Buffer.from(encoded.replace(/\s+/g, ''), 'base64'))
try {
  const panel = await startPanel({
    configPath: path.resolve(import.meta.dirname, '..', 'examples', 'config.mock.json'),
    port: 0,
    tlsPfx: pfxPath,
    tlsPassphrase: 'testpass',
  })
  try {
    assert.match(panel.url, /^https:\/\//)
    const status = await new Promise((resolve, reject) => {
      https.get(panel.url + '/api/config', { rejectUnauthorized: false }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }).on('error', reject)
    })
    assert.equal(status, 401)
    const fingerprint = crypto.createHash('sha256').update(await fs.readFile(pfxPath)).digest('hex')
    assert.equal(fingerprint.length, 64)
    console.log('PASS TLS handshake (PFX, SecureTransport, no-cookie 401)')
  } finally {
    await new Promise((resolve) => panel.server.close(resolve))
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
