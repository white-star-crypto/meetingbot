import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { protectedPathsFor } from './protected-paths.mjs'
import { canonicalPath as canonical } from './path-canonical.mjs'

export const PERMISSION_MODES = {
  'read-only': {
    id: 'read-only',
    label: '只读',
    short: '只读',
    requiresDisclaimer: false,
    description: '只能读取文件和浏览网页。不会写入、删除或运行任何代码；一切修改都会被拒绝，不需要你确认。',
  },
  workspace: {
    id: 'workspace',
    label: '工作区',
    short: '工作区',
    requiresDisclaimer: false,
    description: '工作区内直接执行，不问你。要写出工作区、动系统目录/注册表、或做不可逆操作时，会先问你。',
  },
  'self-review': {
    id: 'self-review',
    label: '自审',
    short: '自审',
    requiresDisclaimer: true,
    description: '模型自己决定并执行，通常不问你。只有碰到 C 盘/系统目录/注册表、不可逆操作、或信息不足时才问你。写入会先备份到 state/backups。',
  },
  full: {
    id: 'full',
    label: '完全权限',
    short: '完全',
    requiresDisclaimer: true,
    description: '几乎不问你：给什么任务就照着执行，不做自动备份。不可逆操作也可能直接执行。这是最高风险级别。',
  },
}

export const DISCLAIMER_TEXT = `自审 / 完全权限会让 Agent 具备修改本机文件、运行 Python 代码的能力。错误或恶意操作可能造成不可逆的数据丢失、凭据泄露或系统损坏。自审模式会尽量为写入做备份，但只在模型认为需要时询问你（例如 C 盘、系统目录、注册表或不可逆操作）；完全权限几乎不会询问你，会按给定任务直接执行。两种模式都不保证覆盖所有操作；你需要自行确认任务、路径和代码，并承担由此产生的风险。`

const MODE_ORDER = ['read-only', 'workspace', 'self-review', 'full']

// A meeting may remember its own mode, but it may never widen the current
// machine-wide permission. The stricter of the two wins.
export function mostRestrictiveMode(...modes) {
  const valid = modes
    .map((mode) => String(mode || ''))
    .filter((mode) => MODE_ORDER.includes(mode))
  if (!valid.length) return 'read-only'
  return valid.sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b))[0]
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createPermissionStore({ statePath, workspaceRoot, auditPath, dataRoot = workspaceRoot }) {
  const file = path.resolve(statePath)
  const initialRoot = path.resolve(workspaceRoot)
  let root = initialRoot
  const resolvedDataRoot = path.resolve(dataRoot || initialRoot)
  const audit = path.resolve(auditPath)
  const defaults = {
    schema: 'heyi/permissions/v1',
    mode: 'read-only',
    workspaceRoot: root,
    workspaceBound: false,
    accepted: { 'self-review': false, full: false },
    updatedAt: new Date().toISOString(),
  }
  let state = clone(defaults)
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (PERMISSION_MODES[raw.mode]) state.mode = raw.mode
      if (typeof raw.workspaceRoot === 'string' && path.isAbsolute(raw.workspaceRoot)) state.workspaceRoot = path.resolve(raw.workspaceRoot)
      state.workspaceBound = raw.workspaceBound === true
      if (raw.accepted && typeof raw.accepted === 'object') {
        state.accepted['self-review'] = raw.accepted['self-review'] === true
        state.accepted.full = raw.accepted.full === true
      }
    }
  } catch { /* keep defaults */ }
  root = path.resolve(state.workspaceRoot || initialRoot)
  let rootCanonical = canonical(root)
  let protectedSet = protectedPathsFor({ root, dataRoot: resolvedDataRoot })
  let protectedFiles = new Set(protectedSet.files.map(canonical))
  let protectedDirs = protectedSet.dirs.map(canonical)

  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
  }
  if (!fs.existsSync(file)) persist()

  const logAudit = (event) => {
    try {
      fs.mkdirSync(path.dirname(audit), { recursive: true })
      fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), mode: state.mode, ...event }) + '\n', 'utf8')
    } catch { /* audit must not break a tool */ }
  }

  const publicState = () => ({
    mode: state.mode,
    accepted: { ...state.accepted },
    workspaceRoot: root,
    workspaceBound: state.workspaceBound === true,
    modes: Object.values(PERMISSION_MODES).map(({ id, label, short, requiresDisclaimer, description }) => ({
      id, label, short, requiresDisclaimer, description,
    })),
    disclaimer: DISCLAIMER_TEXT,
    auditPath: audit,
    updatedAt: state.updatedAt,
  })

  const setMode = ({ mode, acceptDisclaimer = false }) => {
    const next = PERMISSION_MODES[mode]
    if (!next) {
      const error = new Error('unknown permission mode: ' + mode)
      error.status = 400
      error.code = 'UNKNOWN_PERMISSION_MODE'
      throw error
    }
    if (next.requiresDisclaimer && !state.accepted[mode]) {
      if (!acceptDisclaimer) {
        const error = new Error('disclaimer acceptance required for ' + next.label)
        error.status = 403
        error.code = 'DISCLAIMER_REQUIRED'
        error.mode = mode
        throw error
      }
      state.accepted[mode] = true
    }
    state.mode = mode
    state.updatedAt = new Date().toISOString()
    persist()
    logAudit({ event: 'permission-mode', mode, accepted: acceptDisclaimer })
    return publicState()
  }

  const current = () => PERMISSION_MODES[state.mode]
  const deny = (message, code = 'PERMISSION_DENIED') => {
    const error = new Error(message)
    error.status = code === 'CONFIRM_REQUIRED' ? 409 : 403
    error.code = code
    throw error
  }

  // Symlink/junction-safe path resolution. A lexical path.relative check would
  // let a link inside the workspace point at C:\Windows.
  const inside = (target) => {
    const absolute = canonical(target)
    const rel = path.relative(rootCanonical, absolute)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  const isProtected = (absolute) => protectedFiles.has(absolute) || protectedDirs.some((dir) => absolute === dir || absolute.startsWith(dir + path.sep))

  const applyRoot = (next) => {
    root = path.resolve(next)
    state.workspaceRoot = root
    rootCanonical = canonical(root)
    protectedSet = protectedPathsFor({ root, dataRoot: resolvedDataRoot })
    protectedFiles = new Set(protectedSet.files.map(canonical))
    protectedDirs = protectedSet.dirs.map(canonical)
  }

  const setWorkspaceRoot = (nextRoot) => {
    const raw = String(nextRoot || '').trim()
    if (!raw || !path.isAbsolute(raw)) {
      const error = new Error('工作区必须是绝对路径')
      error.status = 400
      error.code = 'INVALID_WORKSPACE_ROOT'
      throw error
    }
    const next = path.resolve(raw)
    let stat
    try { stat = fs.statSync(next) } catch {
      const error = new Error('工作区文件夹不存在：' + next)
      error.status = 400
      error.code = 'INVALID_WORKSPACE_ROOT'
      throw error
    }
    if (!stat.isDirectory()) {
      const error = new Error('工作区必须是文件夹：' + next)
      error.status = 400
      error.code = 'INVALID_WORKSPACE_ROOT'
      throw error
    }
    const previous = root
    applyRoot(next)
    state.workspaceBound = true
    state.updatedAt = new Date().toISOString()
    persist()
    logAudit({ event: 'workspace-root', from: previous, to: root })
    return publicState()
  }


  const confirmations = new Map()
  const pruneConfirmations = () => {
    const now = Date.now()
    for (const [token, record] of confirmations) {
      if (record.expiresAt < now) confirmations.delete(token)
    }
    while (confirmations.size > 256) confirmations.delete(confirmations.keys().next().value)
  }
  const issueConfirmation = (kind, target, ttlMs = 120000) => {
    pruneConfirmations()
    const absolute = canonical(target)
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + Math.max(1000, Math.min(600000, Number(ttlMs) || 120000))
    confirmations.set(token, { kind: String(kind), target: absolute, expiresAt })
    logAudit({ event: 'confirmation-issued', kind, path: absolute })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }
  const consumeConfirmation = (kind, target, token) => {
    pruneConfirmations()
    const key = String(token || '')
    const record = confirmations.get(key)
    if (!record) return false
    confirmations.delete(key)
    if (record.expiresAt < Date.now()) return false
    return record.kind === String(kind) && record.target === target
  }

  const assertRead = (target) => {
    // Read-only is a real confidentiality boundary for credentials and control
    // files. It is not a jail for ordinary workspace source, but it must not
    // expose the vault that the Python sandbox already protects.
    const absolute = canonical(target)
    if (isProtected(absolute)) {
      logAudit({ event: 'fs-read-denied', path: absolute })
      deny('这是凭据/权限/审计控制文件，不允许通过文件工具读取：' + absolute, 'PROTECTED_FILE')
    }
    logAudit({ event: 'fs-read-check', path: absolute })
    return absolute
  }

  const isSymlink = (absolute) => {
    try { return fs.lstatSync(absolute).isSymbolicLink() } catch { return false }
  }

  const symlinkComponent = (target) => {
    const absolute = path.resolve(target)
    const rootLexical = path.resolve(root)
    const withinRoot = absolute === rootLexical || absolute.startsWith(rootLexical + path.sep)
    let current = withinRoot ? rootLexical : path.parse(absolute).root
    for (const part of path.relative(current, absolute).split(path.sep)) {
      if (!part || part === '.') continue
      current = path.join(current, part)
      if (isSymlink(current)) return current
    }
    return ''
  }

  const assertWrite = (target, { confirmToken = '' } = {}) => {
    const lexical = path.resolve(target)
    if (state.mode === 'read-only') deny('只读模式不允许写入：' + lexical)
    const linked = symlinkComponent(lexical)
    if (linked) deny('不允许通过符号链接写入：' + linked, 'SYMLINK_DENIED')
    const absolute = canonical(target)
    if (state.mode === 'read-only') deny('只读模式不允许写入：' + absolute)
    if (state.mode === 'workspace' && !inside(absolute)) deny('工作区模式只能写入应用工作区：' + absolute)
    if (isProtected(absolute)) deny('这是权限/审计/凭据控制文件，不允许通过工具改写：' + absolute, 'PROTECTED_FILE')
    if (fs.existsSync(absolute) && !consumeConfirmation('overwrite', absolute, confirmToken)) {
      deny('覆盖已存在文件需要用户确认（confirmToken）', 'CONFIRM_REQUIRED')
    }
    logAudit({ event: 'fs-write', path: absolute })
    return absolute
  }

  const assertMkdir = (target) => {
    const lexical = path.resolve(target)
    const linked = symlinkComponent(lexical)
    if (linked) deny('不允许通过符号链接创建目录：' + linked, 'SYMLINK_DENIED')
    const absolute = canonical(target)
    if (isProtected(absolute)) deny('这是权限/审计/凭据控制文件，不允许通过工具改写：' + absolute, 'PROTECTED_FILE')
    if (state.mode === 'read-only') deny('只读模式不允许创建目录：' + absolute)
    if (state.mode === 'workspace' && !inside(absolute)) deny('工作区模式只能写入应用工作区：' + absolute)
    if (fs.existsSync(absolute)) {
      if (!fs.statSync(absolute).isDirectory()) deny('路径已存在且不是目录：' + absolute, 'NOT_A_DIRECTORY')
      logAudit({ event: 'fs-mkdir-existing', path: absolute })
      return absolute
    }
    logAudit({ event: 'fs-mkdir', path: absolute })
    return absolute
  }

  const assertDelete = (target, confirmed = false) => {
    const lexical = path.resolve(target)
    const linked = symlinkComponent(path.dirname(lexical))
    if (linked) deny('不允许通过符号链接父目录删除：' + linked, 'SYMLINK_DENIED')
    let link = false
    try { link = fs.lstatSync(lexical).isSymbolicLink() } catch { /* missing or dangling */ }
    const absolute = link ? lexical : canonical(target)
    if (state.mode === 'read-only') deny('只读模式不允许删除：' + absolute)
    if (state.mode === 'workspace' && !inside(absolute)) deny('工作区模式只能删除工作区内的路径：' + absolute)
    if (isProtected(absolute)) deny('这是凭据/权限/审计控制文件，不允许通过工具删除：' + absolute, 'PROTECTED_FILE')
    if (!confirmed) deny('删除必须由用户确认（confirm=true）。', 'CONFIRM_REQUIRED')
    logAudit({ event: 'fs-delete', path: absolute, symlink: link })
    return absolute
  }

  const assertPython = (cwd) => {
    if (state.mode === 'read-only') deny('只读模式不允许运行 Python。切到“自审”或“完全权限”。')
    if (state.mode === 'workspace') deny('工作区模式不允许运行 Python；请切到“自审”或“完全权限”，并确认残余风险。')
    const absolute = canonical(cwd || root)
    logAudit({ event: 'python', cwd: absolute })
    return absolute
  }

  const backupFile = (target, tag = 'write') => {
    if (state.mode !== 'self-review') return null
    const absolute = path.resolve(target)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null
    const backupDir = path.join(resolvedDataRoot, 'state', 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}-${path.basename(absolute)}`
    const copy = path.join(backupDir, name)
    fs.copyFileSync(absolute, copy)
    logAudit({ event: 'backup', source: absolute, backup: copy })
    return copy
  }

  return {
    path: file,
    get root() { return root },
    dataRoot: resolvedDataRoot,
    publicState,
    setMode,
    setWorkspaceRoot,
    current,
    assertRead,
    isProtected: (target) => isProtected(canonical(target)),
    assertWrite,
    assertMkdir,
    assertDelete,
    assertPython,
    issueConfirmation,
    consumeConfirmation,
    backupFile,
    audit: logAudit,
  }
}
