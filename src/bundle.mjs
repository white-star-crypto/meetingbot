import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { resolveDataRoot } from './data-root.mjs'
import path from 'node:path'
import { tally } from './tally.mjs'

const BUNDLE_SCHEMA = 'meetingbot/export/v1'
const KEY_SCHEMA = 'meetingbot/export-key/v1'
const ALLOWED = ['decision.json', 'votes.json', 'tally-audit.json', 'brief.md', 'meta.json', 'critiques.json']

function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('bundle contains a non-finite number')
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function keyPath(explicit) {
  return path.resolve(explicit || process.env.MEETINGBOT_EXPORT_KEY_FILE || path.join(resolveDataRoot(), 'state', 'export-key.pem'))
}

async function loadPrivateKey(file) {
  const target = await keyPath(file)
  try {
    const pem = await fs.readFile(target, 'utf8')
    return { privateKey: crypto.createPrivateKey(pem), publicKey: crypto.createPublicKey(pem), file: target, created: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await fs.mkdir(path.dirname(target), { recursive: true })
    const pair = crypto.generateKeyPairSync('ed25519')
    await fs.writeFile(target, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 })
    try { await fs.chmod(target, 0o600) } catch { /* Windows best effort */ }
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, file: target, created: true }
  }
}

function publicKeyPem(publicKey) {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString()
}

function fingerprint(pem) {
  return crypto.createHash('sha256').update(String(pem)).digest('hex')
}

async function trustAnchor(presentedPem, explicit) {
  const expected = String(explicit || process.env.MEETINGBOT_EXPORT_PUBKEY || '').trim()
  if (expected) {
    if (expected.startsWith('sha256:')) {
      if (expected.slice(7).toLowerCase() !== fingerprint(presentedPem)) throw new Error('bundle public key does not match the pinned fingerprint')
    } else {
      const pinned = publicKeyPem(crypto.createPublicKey(expected))
      if (pinned !== presentedPem) throw new Error('bundle public key does not match the pinned key')
    }
    return { source: 'external', fingerprint: fingerprint(presentedPem) }
  }
  const pinFile = path.resolve(process.env.MEETINGBOT_EXPORT_PUBKEY_FILE || path.join(resolveDataRoot(), 'state', 'export-key.pub.pem'))
  try {
    const pinned = await fs.readFile(pinFile, 'utf8')
    if (pinned.trim() !== presentedPem.trim()) throw new Error('TOFU public key mismatch: refusing a re-signed bundle')
    return { source: 'tofu', fingerprint: fingerprint(presentedPem), pinFile }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await fs.mkdir(path.dirname(pinFile), { recursive: true })
    await fs.writeFile(pinFile, presentedPem, 'utf8')
    return { source: 'tofu-new', fingerprint: fingerprint(presentedPem), pinFile }
  }
}

export async function exportRun(runDir, { outPath, keyFile } = {}) {
  const dir = path.resolve(runDir)
  const files = {}
  for (const name of ALLOWED) {
    try {
      const data = await fs.readFile(path.join(dir, name))
      files[name] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, content: data.toString('base64') }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const proposalsDir = path.join(dir, 'proposals')
  try {
    for (const name of (await fs.readdir(proposalsDir)).sort()) {
      if (!/^P\d+\.json$/.test(name) && name !== '_index.json') continue
      const data = await fs.readFile(path.join(proposalsDir, name))
      files[`proposals/${name}`] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, content: data.toString('base64') }
    }
  } catch { /* no proposals directory */ }
  if (!files['decision.json']) throw new Error('run has no decision.json')
  const id = path.basename(dir)
  const manifest = {
    schema: BUNDLE_SCHEMA,
    runId: id,
    createdAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { sha256: data.sha256, size: data.size }])),
  }
  const key = await loadPrivateKey(keyFile)
  const signature = crypto.sign(null, Buffer.from(canonical({ manifest, files })), key.privateKey).toString('base64')
  const bundle = { schema: BUNDLE_SCHEMA, manifest, files, signature: { alg: 'ed25519', publicKey: publicKeyPem(key.publicKey), value: signature } }
  const target = path.resolve(outPath || path.join(dir, `${id}.meetingbot-bundle.json`))
  await fs.writeFile(target, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
  const publicFile = key.file.replace(/\.pem$/, '') + '.pub.pem'
  try { await fs.writeFile(publicFile, publicKeyPem(key.publicKey), { encoding: 'utf8', mode: 0o644 }) } catch { /* derivation still works */ }
  return { path: target, runId: id, files: Object.keys(files).length, keyFile: key.file, publicKeyFile: publicFile, fingerprint: fingerprint(publicKeyPem(key.publicKey)), keyCreated: key.created }
}

export async function verifyBundle(bundlePath, { outDir, publicKey } = {}) {
  const target = path.resolve(bundlePath)
  const bundle = JSON.parse(await fs.readFile(target, 'utf8'))
  if (bundle?.schema !== BUNDLE_SCHEMA || !bundle.manifest || !bundle.files || !bundle.signature) throw new Error('invalid bundle shape')
  if (bundle.signature.alg !== 'ed25519' || typeof bundle.signature.value !== 'string') throw new Error('unsupported bundle signature algorithm')
  const presentedPem = publicKeyPem(crypto.createPublicKey(bundle.signature.publicKey))
  const trust = await trustAnchor(presentedPem, publicKey)
  const key = crypto.createPublicKey(bundle.signature.publicKey)
  const ok = crypto.verify(null, Buffer.from(canonical({ manifest: bundle.manifest, files: bundle.files })), key, Buffer.from(bundle.signature.value, 'base64'))
  if (!ok) throw new Error('bundle signature is invalid')
  const results = []
  for (const [name, data] of Object.entries(bundle.files)) {
    if (!data || typeof data.content !== 'string' || !data.sha256) throw new Error(`invalid file entry: ${name}`)
    if (name.includes('..') || name.includes(':') || name.includes('\\') || path.isAbsolute(name)) throw new Error(`unsafe bundle path: ${name}`)
    const bytes = Buffer.from(data.content, 'base64')
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    if (digest !== data.sha256) throw new Error(`bundle file hash mismatch: ${name}`)
    if (bundle.manifest.files?.[name]?.sha256 !== digest) throw new Error(`bundle manifest mismatch: ${name}`)
    results.push({ name, bytes })
  }
  if (outDir) {
    const root = path.resolve(outDir)
    for (const { name, bytes } of results) {
      const file = path.join(root, name)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, bytes)
    }
  }
  return { bundle: target, document: bundle, runId: bundle.manifest.runId, files: results.length, outDir: outDir ? path.resolve(outDir) : null, trustSource: trust.source, publicKeyFingerprint: trust.fingerprint, pinFile: trust.pinFile || null }
}

export async function replayBundle(bundlePath, { publicKey } = {}) {
  const verified = await verifyBundle(bundlePath, { publicKey })
  const bundle = verified.document
  if (!bundle.files['decision.json'] || !bundle.files['votes.json'] || !bundle.files['tally-audit.json']) {
    throw new Error('bundle is not replayable: decision.json, votes.json and tally-audit.json are required')
  }
  const decision = JSON.parse(Buffer.from(bundle.files['decision.json'].content, 'base64').toString('utf8'))
  const votes = JSON.parse(Buffer.from(bundle.files['votes.json'].content, 'base64').toString('utf8'))
  const proposals = Object.entries(bundle.files)
    .filter(([name]) => /^proposals\/P\d+\.json$/.test(name))
    .map(([, data]) => JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')))
  const savedAudit = JSON.parse(Buffer.from(bundle.files['tally-audit.json'].content, 'base64').toString('utf8'))
  const result = tally(proposals, votes.rows || [], {
    dimensionWeights: savedAudit.dimensionWeights,
    method: savedAudit.method === 'condorcet' ? 'condorcet' : (savedAudit.method === 'weighted-average' ? 'weighted' : 'auto'),
    selfScorePolicy: savedAudit.selfScorePolicy,
    selfScoreWeight: savedAudit.selfScoreWeight,
    stripSelfFromRanking: savedAudit.stripSelfFromRanking,
    voterTagBoost: savedAudit.voterTagBoost,
  })
  return { ...verified, expectedWinner: decision.winner, replayWinner: result.winnerId, matches: decision.winner === result.winnerId, tally: result }
}
