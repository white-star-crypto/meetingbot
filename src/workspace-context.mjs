import fs from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', 'build', 'state', 'runs', 'backup', 'panel-screenshots', 'coverage', '.cache', 'tmp'])
const SKIP_FILE = /(^|\/)(\.env|.*\.key|.*\.pem|providers\.vault|meeting\.config\.local\.json|.*\.log)$/i
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.yml', '.yaml', '.toml', '.sql', '.ps1', '.cmd', '.bat'])
const MAX_FILE_BYTES = 24 * 1024
const MAX_TOTAL_CHARS = 64 * 1024

const clean = (value, max = 4000) => String(value ?? '').replace(/\u0000/g, '').slice(0, max)
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/')

async function listFiles(root) {
  const files = []
  const walk = async (dir, depth) => {
    if (depth > 8) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1); continue }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!TEXT_EXT.has(ext)) continue
      if (SKIP_FILE.test(entry.name)) continue
      const info = await fs.stat(full).catch(() => null)
      if (!info || info.size > MAX_FILE_BYTES) continue
      files.push({ full, rel: rel(root, full), size: info.size, ext })
    }
  }
  await walk(root, 0)
  return files
}

function score(file, words) {
  let n = 0
  if (/^(README|LICENSE|NOTICE)/i.test(file.rel)) n += 120
  if (file.rel === 'package.json') n += 120
  if (/^(src|public|electron|tests)\//.test(file.rel)) n += 30
  if (/(^|\/)(index|main|panel|server|app|config)\./i.test(file.rel)) n += 20
  const lower = file.rel.toLowerCase()
  for (const w of words) if (w.length > 1 && lower.includes(w)) n += 12
  return n - Math.min(20, file.rel.split('/').length * 2) - (file.size > 16000 ? 12 : 0)
}

async function dependencyNotes(root) {
  let pkg = null
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) } catch { return '' }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const names = Object.keys(deps).slice(0, 40)
  const lines = ['## Direct dependencies', '']
  for (const name of names) {
    let meta = null
    try { meta = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')) } catch {}
    const bits = [name + '@' + (meta?.version || deps[name])]
    if (meta?.types) bits.push('types=' + clean(meta.types, 120))
    if (meta?.main) bits.push('main=' + clean(meta.main, 120))
    if (meta?.exports && typeof meta.exports === 'object') bits.push('exports=' + clean(Object.keys(meta.exports).slice(0, 6).join(','), 120))
    lines.push('- ' + bits.join(' · '))
  }
  if (names.length) lines.push('', '只列依赖元信息，不发送 node_modules 源码；需要某个包 API 时在需求里点名。')
  return lines.join('\n')
}

export async function collectWorkspaceContext({ root, brief = '', maxFiles = 24 } = {}) {
  const target = path.resolve(String(root || ''))
  if (!path.isAbsolute(target)) throw new Error('workspace path must be absolute')
  const stat = await fs.stat(target).catch(() => null)
  if (!stat?.isDirectory()) throw new Error('workspace path is not a directory')
  const words = clean(brief, 4000).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_.-]+/).filter((w) => w.length >= 2).slice(0, 80)
  const files = (await listFiles(target)).map((f) => ({ ...f, score: score(f, words) })).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  const chosen = []
  let total = 0
  for (const file of files) {
    if (chosen.length >= Math.max(4, Math.min(60, Number(maxFiles) || 24))) break
    const text = await fs.readFile(file.full, 'utf8').catch(() => '')
    if (!text.trim()) continue
    const body = text.length > 12000 ? text.slice(0, 12000) + '\n… [truncated]' : text
    if (total + body.length > MAX_TOTAL_CHARS) break
    chosen.push({ ...file, body }); total += body.length
  }
  const deps = await dependencyNotes(target)
  const tree = files.slice(0, 600).map((f) => f.rel).join('\n')
  const out = [
    '# Workspace context (read-only)',
    '',
    'root: `' + target + '`',
    'generated: ' + new Date().toISOString(),
    'files: ' + chosen.length + ' of ' + files.length + ' text files; chars: ' + total,
    'scope: source/config/docs only; node_modules, state, secrets and binary files excluded.',
    '',
    '## Directory tree (partial)',
    '```text',
    tree,
    '```',
    '',
    deps,
    '',
    '## Files',
    ''
  ]
  for (const file of chosen) {
    out.push('### `' + file.rel + '` (' + file.size + ' bytes)', '```' + (file.ext === '.md' ? 'md' : 'text'), file.body, '```', '')
  }
  return { context: out.join('\n').slice(0, MAX_TOTAL_CHARS + 30000), stats: { root: target, files: chosen.length, scanned: files.length, chars: total } }
}
