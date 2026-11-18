import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { protectedPathsFor } from './protected-paths.mjs'
import { childEnv } from './child-env.mjs'
import { resolveDataRoot } from './data-root.mjs'
import { diffForFile } from './file-diff.mjs'
import { createCheckpoint } from './checkpoints.mjs'

const MAX_READ = 512 * 1024
const MAX_OUTPUT = 200 * 1024
const MAX_BACKUP_BYTES = 256 * 1024 * 1024
const PYTHON_TIMEOUT = 20000
const PYTHON_BIN = process.env.MEETINGBOT_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

function text(value, fallback = '') {
  return String(value ?? fallback)
}

function truncate(value, limit = MAX_OUTPUT) {
  const source = text(value)
  return source.length > limit ? source.slice(0, limit) + '\n…（已截断）' : source
}

function copyTree(source, destination, budget = { bytes: 0 }) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    // Never follow junctions/symlinks into a backup. A link can point at a
    // huge directory or C:\; fs.rmSync itself removes the link, not the target.
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true })
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), budget)
  } else if (stat.isFile()) {
    budget.bytes += stat.size
    if (budget.bytes > MAX_BACKUP_BYTES) throw new Error(`backup too large (max ${MAX_BACKUP_BYTES} bytes)`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

export function fsList({ permissions, target }) {
  const absolute = permissions.assertRead(target || permissions.root)
  const stat = fs.statSync(absolute)
  if (!stat.isDirectory()) throw new Error('not a directory: ' + absolute)
  const entries = fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => !permissions.isProtected?.(path.join(absolute, entry.name)))
    .map((entry) => {
      const full = path.join(absolute, entry.name)
      let size = 0
      let mtime = ''
      try {
        const s = fs.statSync(full)
        size = s.size
        mtime = s.mtime.toISOString()
      } catch {}
      return {
        name: entry.name,
        path: full,
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size,
        mtime,
      }
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return { ok: true, path: absolute, entries }
}

export function fsRead({ permissions, target }) {
  const absolute = permissions.assertRead(target)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error('not a file: ' + absolute)
  if (stat.size > MAX_READ) throw new Error(`file too large (${stat.size} bytes); max ${MAX_READ}`)
  const buffer = fs.readFileSync(absolute)
  if (buffer.includes(0)) throw new Error('binary file cannot be previewed as text')
  return {
    ok: true,
    path: absolute,
    size: stat.size,
    content: truncate(buffer.toString('utf8'), MAX_READ),
  }
}

export function fsWrite({ permissions, target, content, confirmToken = '' }) {
  const absolute = permissions.assertWrite(target, { confirmToken })
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const next = text(content)
  let previous = ''
  let existed = false
  try {
    const stat = fs.statSync(absolute)
    if (stat.isFile()) {
      existed = true
      previous = stat.size <= MAX_READ ? fs.readFileSync(absolute, 'utf8') : ''
    }
  } catch { /* new file */ }
  const preview = diffForFile(absolute, previous, next)
  let checkpoint = null
  let checkpointError = ''
  try {
    checkpoint = createCheckpoint({ permissions, target: absolute, action: 'write' })
  } catch (error) {
    checkpointError = String(error?.message || error)
  }
  const backup = permissions.backupFile(absolute, 'write')
  fs.writeFileSync(absolute, next, 'utf8')
  permissions.audit({ event: 'fs-write-done', path: absolute, backup, checkpoint: checkpoint?.id || '', existed })
  return {
    ok: true,
    path: absolute,
    bytes: Buffer.byteLength(next),
    backup,
    existed,
    diff: preview.diff,
    diffSummary: preview.summary,
    diffTruncated: preview.truncated === true,
    checkpoint,
    checkpointError,
  }
}

export function fsMkdir({ permissions, target }) {
  const absolute = permissions.assertMkdir(target)
  fs.mkdirSync(absolute, { recursive: true })
  return { ok: true, path: absolute }
}

export function fsDelete({ permissions, target, confirm = false }) {
  const absolute = permissions.assertDelete(target, confirm === true)
  let info = null
  try { info = fs.lstatSync(absolute) } catch { /* missing */ }
  if (!info) return { ok: true, path: absolute, missing: true }
  const mode = permissions.current().id
  if (info.isSymbolicLink()) {
    fs.unlinkSync(absolute)
    permissions.audit({ event: 'fs-delete-done', path: absolute, backup: null, mode, symlink: true, checkpoint: '' })
    return { ok: true, path: absolute, backup: null, symlink: true, checkpoint: null, diff: '' }
  }
  let previous = ''
  if (info.isFile() && info.size <= MAX_READ) {
    try { previous = fs.readFileSync(absolute, 'utf8') } catch { previous = '' }
  }
  const preview = info.isFile()
    ? diffForFile(absolute, previous, '')
    : { diff: `(delete ${info.isDirectory() ? 'directory' : 'file'})`, summary: '', truncated: false }
  let checkpoint = null
  let checkpointError = ''
  try {
    checkpoint = createCheckpoint({ permissions, target: absolute, action: 'delete' })
  } catch (error) {
    checkpointError = String(error?.message || error)
  }
  let backup = permissions.backupFile(absolute, 'delete')
  if (mode === 'self-review' && info.isDirectory()) {
    const dir = path.join(resolveDataRoot(), 'state', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-deleted-${path.basename(absolute)}`)
    copyTree(absolute, backup)
  }
  fs.rmSync(absolute, { recursive: true, force: true })
  permissions.audit({ event: 'fs-delete-done', path: absolute, backup, mode, checkpoint: checkpoint?.id || '' })
  return {
    ok: true,
    path: absolute,
    backup,
    checkpoint,
    checkpointError,
    diff: preview.diff,
    diffSummary: preview.summary,
    diffTruncated: preview.truncated === true,
  }
}

function workspacePythonWrapper(workspace, { strict = true, dataRoot = process.cwd() } = {}) {
  const root = JSON.stringify(path.resolve(workspace))
  const guard = protectedPathsFor({ root: path.resolve(workspace), dataRoot })
  const template = fs.readFileSync(path.join(import.meta.dirname, 'python-guard.py'), 'utf8')
  return template
    .replaceAll('__HEYI_ROOT__', root)
    .replaceAll('__HEYI_PROTECTED_FILES__', JSON.stringify(guard.files))
    .replaceAll('__HEYI_PROTECTED_DIRS__', JSON.stringify(guard.dirs))
    .replaceAll('__HEYI_STRICT__', strict ? 'True' : 'False')
}

function runPythonAsync(file, working, userFile) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PYTHON_BIN, ['-I', '-X', 'utf8', file], {
        cwd: working,
        windowsHide: true,
        env: childEnv({ PYTHONIOENCODING: 'utf-8', HEYI_WORKSPACE: working, HEYI_USER_SCRIPT: userFile }),
      })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false, error })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (status, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout, stderr, timedOut, error })
    }
    const append = (current, chunk) => current.length >= MAX_OUTPUT ? current : current + String(chunk).slice(0, MAX_OUTPUT - current.length)
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.on('error', (error) => finish(null, error))
    child.on('close', (status) => finish(status, timedOut ? new Error('ETIMEDOUT') : null))
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already gone */ }
      // Do not leave a wedged child after a kill failure; the close handler
      // still wins normally, this is a bounded fallback.
      setTimeout(() => finish(null, new Error('ETIMEDOUT')), 1500).unref?.()
    }, PYTHON_TIMEOUT)
  })
}

export async function pythonRun({ permissions, code, cwd }) {
  const working = permissions.assertPython(cwd || permissions.root)
  if (!fs.existsSync(working) || !fs.statSync(working).isDirectory()) throw new Error('python cwd is not a directory: ' + working)
  const dataRoot = resolveDataRoot()
  const runDir = path.join(dataRoot, 'state', 'python-runs')
  fs.mkdirSync(runDir, { recursive: true })
  const file = path.join(runDir, `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.py`)
  const userFile = path.join(runDir, `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.py`)
  const mode = permissions.current().id
  const source = workspacePythonWrapper(working, { strict: mode !== 'full', dataRoot })
  fs.writeFileSync(file, source, 'utf8')
  fs.writeFileSync(userFile, text(code), 'utf8')
  const started = Date.now()
  const result = await runPythonAsync(file, working, userFile)
  const durationMs = Date.now() - started
  const stdout = truncate(result.stdout || '')
  const stderr = truncate(result.stderr || (result.error ? String(result.error.message || result.error) : ''))
  permissions.audit({ event: 'python-done', file, durationMs, exitCode: result.status, timedOut: result.timedOut })
  try {
    const keep = 20
    const runs = fs.readdirSync(runDir).filter((name) => name.endsWith('.py')).map((name) => {
      const full = path.join(runDir, name)
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch {}
      return { full, mtime }
    }).sort((a, b) => b.mtime - a.mtime)
    for (const old of runs.slice(keep)) fs.unlinkSync(old.full)
  } catch { /* cleanup must not fail the run */ }
  return {
    ok: !result.timedOut && result.status === 0,
    exitCode: result.status,
    timedOut: result.timedOut,
    durationMs,
    stdout,
    stderr,
    script: file,
    mode,
  }
}

function normalizedHost(target) {
  return target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function privateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224
}

function privateIpv6(raw) {
  const ip = String(raw || '').toLowerCase()
  if (!ip || ip === '::' || ip === '::1') return true
  if (/^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip)) return true
  // NAT64 well-known prefix and the RFC 8215 local-use prefix.
  if (/^64:ff9b::/.test(ip) || /^64:ff9b:1:/.test(ip)) return true
  const dottedMapped = ip.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dottedMapped) return privateIpv4(dottedMapped[1])
  const mapped = ip.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return privateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return false
}

function privateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '')
  if (net.isIP(ip) === 4) return privateIpv4(ip)
  if (net.isIP(ip) === 6) return privateIpv6(ip)
  return false
}

export async function assertPublicUrl(value, base) {
  const target = base ? new URL(text(value).trim(), base) : new URL(text(value).trim())
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('only http/https URLs are allowed')
  if (target.username || target.password) throw new Error('URL credentials are not allowed')
  const host = normalizedHost(target)
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('local/private hosts are blocked for agent browser reads')
  }
  if (net.isIP(host) && privateAddress(host)) {
    throw new Error('local/private hosts are blocked for agent browser reads')
  }
  let addresses
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error(`cannot resolve host: ${host}`)
  }
  if (!addresses.length) throw new Error(`cannot resolve host: ${host}`)
  if (addresses.some((item) => privateAddress(item.address))) {
    throw new Error('host resolves to a private address; agent browser reads are blocked')
  }
  return target
}

function publicDnsLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length) throw new Error(`cannot resolve host: ${hostname}`)
    if (addresses.some((item) => privateAddress(item.address))) {
      throw new Error('host resolves to a private address; agent browser reads are blocked')
    }
    if (options && options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  }).catch((error) => callback(error))
}

export function requestPublic(target, { timeoutMs = 15000, method = 'GET', headers = {}, body = null, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    const module = target.protocol === 'https:' ? https : http
    let settled = false
    const fail = (error) => { if (!settled) { settled = true; reject(error) } }
    const req = module.request(target, {
      method,
      agent: false,
      lookup: allowPrivate ? undefined : publicDnsLookup,
      servername: target.hostname,
      headers: {
        'User-Agent': 'Heyi-Agent/2.1 (+local)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (!settled) { settled = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) }) }
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_READ) {
          req.destroy(new Error(`response too large; max ${MAX_READ} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (!settled) { settled = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) }
      })
      res.on('error', fail)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)))
    req.on('error', fail)
    req.end(body == null ? undefined : body)
  })
}

export async function browserRead({ url, maxChars = 12000 }) {
  let target = await assertPublicUrl(url)
  for (let hop = 0; hop < 5; hop++) {
    const response = await requestPublic(target)
    const location = response.headers.location
    if (location && [301, 302, 303, 307, 308].includes(response.status)) {
      target = await assertPublicUrl(location, target)
      continue
    }
    const html = response.body.toString('utf8')
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200) : ''
    const plain = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      url: target.href,
      title,
      content: truncate(plain, Math.max(1000, Math.min(30000, Number(maxChars) || 12000))),
    }
  }
  throw new Error('too many redirects')
}

function approvalPreview(action, args) {
  const target = path.resolve(String(args?.path || ''))
  let before = ''
  let kind = 'write'
  try {
    const stat = fs.lstatSync(target)
    if (stat.isFile() && stat.size <= MAX_READ) before = fs.readFileSync(target, 'utf8')
    if (action === 'fs.delete') kind = stat.isDirectory() ? 'directory' : 'file'
  } catch { /* new file or missing target */ }
  if (action === 'fs.delete') {
    const preview = kind === 'directory'
      ? { diff: `(delete directory) ${target}`, summary: '', truncated: false }
      : diffForFile(target, before, '')
    return {
      preview: preview.diff,
      previewSummary: preview.summary,
      previewTruncated: preview.truncated === true,
      previewKind: kind,
    }
  }
  const preview = diffForFile(target, before, text(args?.content))
  return {
    preview: preview.diff,
    previewSummary: preview.summary,
    previewTruncated: preview.truncated === true,
    previewKind: 'file',
  }
}

function scopedWriteAllowed(scope, target) {
  const allowed = (Array.isArray(scope?.allowedPaths) ? scope.allowedPaths : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
  if (!allowed.length) return true
  const absolute = path.resolve(String(target || ''))
  return allowed.some((root) => {
    const rel = path.relative(root, absolute)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}
function scopeDenied(target) {
  return { ok: false, code: 'SCOPE_DENIED', error: `超出批准路径白名单：${path.resolve(String(target || ''))}` }
}
export async function executeAgentTool({ permissions, action, args = {}, approved = false, scope = null }) {
  const name = text(action)
  if (name === 'fs.write' && !scopedWriteAllowed(scope, args.path)) return scopeDenied(args.path)
  if (name === 'fs.mkdir' && !scopedWriteAllowed(scope, args.path)) return scopeDenied(args.path)
  if (name === 'fs.delete' && !scopedWriteAllowed(scope, args.path)) return scopeDenied(args.path)
  if (name === 'python.run' && !scopedWriteAllowed(scope, args.cwd || permissions?.root)) return scopeDenied(args.cwd || permissions?.root)
  if (name === 'fs.list') return fsList({ permissions, target: args.path })
  if (name === 'fs.read') return fsRead({ permissions, target: args.path })
  if (name === 'fs.write') {
    try {
      return fsWrite({ permissions, target: args.path, content: args.content, confirmToken: args.confirmToken })
    } catch (error) {
      if (error?.code === 'CONFIRM_REQUIRED' && args.path) {
        return { ok: false, code: 'CONFIRM_REQUIRED', needsConfirmation: true, approval: { kind: 'overwrite', action: 'fs.write', target: path.resolve(String(args.path)), args: { ...args }, ...approvalPreview('fs.write', args) } }
      }
      throw error
    }
  }
  if (name === 'fs.mkdir') return fsMkdir({ permissions, target: args.path })
  if (name === 'fs.delete') {
    // An Agent is not a human approval channel. Deletion must be confirmed by
    // the owner in the panel (confirm=true); never auto-approve it just because
    // the current mode is not read-only.
    try {
      return fsDelete({ permissions, target: args.path, confirm: approved === true })
    } catch (error) {
      if (error?.code === 'CONFIRM_REQUIRED' && args.path) {
        return { ok: false, code: 'CONFIRM_REQUIRED', needsConfirmation: true, approval: { kind: 'delete', action: 'fs.delete', target: path.resolve(String(args.path)), args: { ...args }, ...approvalPreview('fs.delete', args) } }
      }
      throw error
    }
  }
  if (name === 'python.run') return pythonRun({ permissions, code: args.code, cwd: args.cwd })
  if (name === 'browser.open') {
    const parsed = await assertPublicUrl(args.url)
    return { ok: true, url: parsed.href, note: '已交给内置浏览器打开' }
  }
  if (name === 'browser.read') return browserRead({ url: args.url, maxChars: args.maxChars })
  throw new Error('unknown tool: ' + name)
}
