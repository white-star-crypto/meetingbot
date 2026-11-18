#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { runMeeting } from '../src/meeting.mjs'
import { exportRun, replayBundle, verifyBundle } from '../src/bundle.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-bundle-'))
process.env.MEETINGBOT_EXPORT_PUBKEY_FILE = path.join(root, 'trusted-pub.pem')
const brief = path.join(root, 'brief.md')
await fs.writeFile(brief, '# Bundle test\n\nBuild a tiny page.\n', 'utf8')
try {
  const meeting = await runMeeting({
    briefPath: brief,
    configPath: path.resolve(import.meta.dirname, '..', 'examples', 'config.mock.json'),
    outDir: path.join(root, 'runs'),
    mock: true,
  })
  const key = path.join(root, 'export-key.pem')
  const exported = await exportRun(meeting.runDir, { outPath: path.join(root, 'bundle.json'), keyFile: key })
  const verified = await verifyBundle(exported.path)
  assert.equal(verified.runId, path.basename(meeting.runDir))
  assert.ok(verified.files >= 4)
  const replay = await replayBundle(exported.path)
  assert.equal(replay.matches, true)

  const original = JSON.parse(await fs.readFile(exported.path, 'utf8'))
  const attacker = crypto.generateKeyPairSync('ed25519')
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
  const resigned = {
    ...original,
    signature: {
      alg: 'ed25519',
      publicKey: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      value: crypto.sign(null, Buffer.from(canonical({ manifest: original.manifest, files: original.files })), attacker.privateKey).toString('base64'),
    },
  }
  const resignedPath = path.join(root, 'resigned.json')
  await fs.writeFile(resignedPath, JSON.stringify(resigned), 'utf8')
  await assert.rejects(() => verifyBundle(resignedPath), /TOFU public key mismatch|does not match/)

  const bundle = JSON.parse(await fs.readFile(exported.path, 'utf8'))
  bundle.files['decision.json'].content = Buffer.from('{"tampered":true}').toString('base64')
  await fs.writeFile(exported.path, JSON.stringify(bundle), 'utf8')
  await assert.rejects(() => verifyBundle(exported.path), /signature is invalid|hash mismatch/)
  console.log('PASS signed export bundle, tamper rejection, replay match')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
