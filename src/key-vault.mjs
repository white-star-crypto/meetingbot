import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

const ROOT = process.env.MEETINGBOT_VAULT_DIR || path.join(resolveDataRoot(), 'config')
const VAULT_FILE = path.join(ROOT, 'providers.vault.json')
const MASTER_FILE = path.join(ROOT, 'providers.vault.key')
const PREV_MASTER_FILE = MASTER_FILE + '.prev'

function atomicWrite(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, mode) } catch {}
}

function deriveEnvKey() {
  const secret = String(process.env.MEETINGBOT_VAULT_KEY || '')
  if (!secret) return null
  return crypto.scryptSync(secret, 'meetingbot-vault-v1', 32)
}

function decodeMaster(file) {
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
  return key.length === 32 ? key : null
}

function masterKeys() {
  const envKey = deriveEnvKey()
  if (envKey) return [envKey]
  fs.mkdirSync(ROOT, { recursive: true })
  if (!fs.existsSync(MASTER_FILE)) {
    const key = crypto.randomBytes(32)
    atomicWrite(MASTER_FILE, key.toString('base64') + '\n', 0o600)
    return [key]
  }
  const current = decodeMaster(MASTER_FILE)
  if (!current) throw new Error('key vault master key is corrupt; refusing to overwrite it')
  if (!fs.existsSync(PREV_MASTER_FILE)) return [current]
  const previous = decodeMaster(PREV_MASTER_FILE)
  return previous ? [current, previous] : [current]
}

function ensureMaster() {
  return masterKeys()[0]
}

function readVault() {
  if (!fs.existsSync(VAULT_FILE)) return {}
  let raw
  try { raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) } catch {
    throw new Error('key vault file is corrupt; refusing to overwrite it')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('key vault file has an invalid shape')
  return raw
}

function writeVault(vault) {
  fs.mkdirSync(ROOT, { recursive: true })
  atomicWrite(VAULT_FILE, JSON.stringify(vault, null, 2) + '\n', 0o600)
}

export function putSecret(name, secret) {
  const label = String(name || '').trim()
  const value = String(secret || '').trim()
  if (!label || !value) throw new Error('name and secret are required')
  const key = ensureMaster()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const vault = readVault()
  vault[label] = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    updatedAt: new Date().toISOString(),
  }
  writeVault(vault)
  return { name: label, updatedAt: vault[label].updatedAt }
}

export function getSecret(name) {
  try {
    const entry = readVault()[String(name || '').trim()]
    if (!entry) return ''
    let lastError = null
    for (const key of masterKeys()) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
      } catch (error) { lastError = error }
    }
    throw lastError || new Error('key vault decryption failed')
  } catch (error) {
    if (!globalThis.__meetingbotVaultWarned) {
      console.error('key vault unavailable: ' + String(error?.message || error))
      globalThis.__meetingbotVaultWarned = true
    }
    return ''
  }
}

export function rotateMaster() {
  if (deriveEnvKey()) throw new Error('cannot rotate the master key while MEETINGBOT_VAULT_KEY is set')
  const vault = readVault()
  const oldKey = ensureMaster()
  atomicWrite(PREV_MASTER_FILE, oldKey.toString('base64') + '\n', 0o600)
  const nextKey = crypto.randomBytes(32)
  const next = {}
  for (const [name, entry] of Object.entries(vault)) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', oldKey, Buffer.from(entry.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', nextKey, iv)
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    next[name] = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'), updatedAt: new Date().toISOString() }
  }
  atomicWrite(MASTER_FILE, nextKey.toString('base64') + '\n', 0o600)
  writeVault(next)
  try { fs.unlinkSync(PREV_MASTER_FILE) } catch { /* keep the recovery copy if another process is reading it */ }
  return { rotated: Object.keys(next).length }
}

export function listSecrets() {
  return Object.entries(readVault()).map(([name, entry]) => ({ name, updatedAt: entry.updatedAt || null }))
}

export const vaultPaths = { ROOT, VAULT_FILE, MASTER_FILE }
