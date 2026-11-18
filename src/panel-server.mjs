import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, publicRoster } from './config.mjs'
import { canonicalParticipants } from './model-aliases.mjs'
import { getSecret, listSecrets, putSecret } from './key-vault.mjs'
import { repairDecision, runMeeting } from './meeting.mjs'
import { askSingle } from './single.mjs'
import { compareModels, mergeCompare } from './compare.mjs'
import { listRuns } from './run-center.mjs'
import { collectUsage, readRunTimeline } from './usage-center.mjs'
import { createGroupStore } from './group-chat.mjs'
import { createMemoryStore } from './memory-store.mjs'
import { createPluginStateStore } from './plugin-state.mjs'
import { createPluginCatalog } from './plugin-catalog.mjs'
import { EXTERNAL_SKILLS, externalSkillsPublic } from './external-skills.mjs'
import { createCompareHistoryStore } from './compare-history.mjs'
import { createPreferencesStore } from './preferences.mjs'
import { createAccountService } from './account-service.mjs'
import { collectWorkspaceContext } from './workspace-context.mjs'
import { createMcpManager } from './mcp-client.mjs'
import { buildFollowupBriefFromRun } from './rounds.mjs'
import { createRosterStore } from './roster-store.mjs'
import { reviewImage, visionCandidates } from './vision-guard.mjs'
import { createPermissionStore, mostRestrictiveMode, PERMISSION_MODES } from './permissions.mjs'
import { createSessionStore } from './session-store.mjs'
import { buildApprovedExecutorTask, createDecisionApprovalStore, decisionApprovalBlockReason, decisionTasks } from './decision-approval.mjs'
import { previewPaths } from './file-preview.mjs'
import { createDecisionLedgerStore } from './decision-ledger.mjs'
import { createDecisionOntologyStore } from './decision-ontology.mjs'
import { createAgentPresetStore } from './agent-presets.mjs'
import { validateDecisionDocument } from './decision-schema.mjs'
import { resolveDataRoot } from './data-root.mjs'
import { browserRead, fsDelete, fsList, fsMkdir, fsRead, fsWrite, pythonRun, assertPublicUrl, requestPublic } from './tools.mjs'
import { resumeAgentTask, runAgentTask } from './agent-runner.mjs'
import { listCheckpoints, restoreCheckpoint } from './checkpoints.mjs'
import { runRevision } from './revision.mjs'
import { compressHistory } from './context.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(here, '..', 'public')
const appVersion = (() => {
  try { return String(JSON.parse(fsSync.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version || '') } catch { return '' }
})()

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

export function startPanel({ configPath, port = 4318, host = '127.0.0.1', token = '', tlsCert = '', tlsKey = '', tlsPfx = '', tlsPassphrase = '', allowInsecure = false }) {
  const config = loadConfig(configPath, { requireKeys: false })
  const remote = !['127.0.0.1', 'localhost'].includes(String(host || '').toLowerCase())
  const remoteKey = String(token || process.env.MEETINGBOT_PANEL_TOKEN || '').trim()
  if (remote && !remoteKey) throw new Error('remote panel binding requires --token or MEETINGBOT_PANEL_TOKEN')
  if (!tlsPfx && Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error('TLS requires both --tls-cert and --tls-key, or --tls-pfx')
  const useTls = Boolean(tlsPfx || (tlsCert && tlsKey))
  if (remote && !useTls && !allowInsecure) throw new Error('remote panel binding requires TLS (--tls-cert/--tls-key or --tls-pfx) or explicit --allow-insecure')
  const tlsOptions = useTls ? (tlsPfx ? { pfx: fsSync.readFileSync(tlsPfx), passphrase: tlsPassphrase } : { cert: fsSync.readFileSync(tlsCert), key: fsSync.readFileSync(tlsKey) }) : null
  const scheme = useTls ? 'https' : 'http'
  const panelToken = crypto.randomBytes(32).toString('hex')
  const sessionTtlMs = 12 * 60 * 60 * 1000
  const panelSessions = new Map()
  const loginFailures = new Map()
  const sameToken = (a, b) => {
    const left = Buffer.from(String(a || ''))
    const right = Buffer.from(String(b || ''))
    return left.length === right.length && crypto.timingSafeEqual(left, right)
  }
  const sessionCookie = `meetingbot_session=${panelToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${useTls ? '; Secure' : ''}`
  const readLiveConfig = (requireKeys = false) => loadConfig(configPath, { requireKeys })
  const dataRoot = resolveDataRoot()
  const feedbackFile = path.join(dataRoot, 'feedback', 'feedback.jsonl')
  const stateDir = path.join(dataRoot, 'state')
  const capturesDir = path.join(stateDir, 'captures')
  const snapshotsDir = path.join(stateDir, 'vision-snapshots')
  const scopesDir = path.join(stateDir, 'accounts')
  const legacyMarker = path.join(scopesDir, '.legacy-migrated')
  const extraLegacyMarker = path.join(scopesDir, '.legacy-extra-migrated')
  const accountStateFile = path.join(stateDir, 'account.json')
  const readSignedInAccountId = () => {
    try {
      const profile = JSON.parse(fsSync.readFileSync(accountStateFile, 'utf8'))?.profile
      return profile?.id ? String(profile.id).replace(/[^a-zA-Z0-9_-]/g, '_') : ''
    } catch { return '' }
  }
  const scopeDir = (scope) => path.join(scopesDir, scope || 'guest')
  const migrateLegacyData = (scope) => {
    try {
      if (fsSync.existsSync(legacyMarker)) return
      const target = scopeDir(scope)
      fsSync.mkdirSync(target, { recursive: true })
      const pairs = [
        [path.join(stateDir, 'sessions.json'), path.join(target, 'sessions.json')],
        [path.join(stateDir, 'memory.json'), path.join(target, 'memory.json')],
        [path.join(stateDir, 'groups.json'), path.join(target, 'groups.json')],
        [path.join(stateDir, 'compare-history.json'), path.join(target, 'compare-history.json')],
      ]
      for (const [from, to] of pairs) {
        if (fsSync.existsSync(from) && !fsSync.existsSync(to)) fsSync.copyFileSync(from, to)
      }
      fsSync.writeFileSync(legacyMarker, JSON.stringify({ migratedAt: new Date().toISOString(), scope }) + '\n', 'utf8')
    } catch (error) { console.error('legacy account data migration failed:', error) }
  }
  const copyScopeData = (fromScope, toScope) => {
    try {
      const from = scopeDir(fromScope); const to = scopeDir(toScope)
      fsSync.mkdirSync(to, { recursive: true })
      for (const name of ['sessions.json', 'memory.json', 'groups.json', 'compare-history.json']) {
        const src = path.join(from, name); const dest = path.join(to, name)
        if (fsSync.existsSync(src) && !fsSync.existsSync(dest)) fsSync.copyFileSync(src, dest)
      }
    } catch (error) { console.error('guest data claim failed:', error) }
  }
  const migrateExtraLegacyData = (scope) => {
    try {
      if (fsSync.existsSync(extraLegacyMarker)) return
      const target = scopeDir(scope)
      fsSync.mkdirSync(target, { recursive: true })
      for (const name of ['groups.json', 'compare-history.json']) {
        const src = path.join(stateDir, name); const dest = path.join(target, name)
        if (fsSync.existsSync(src) && !fsSync.existsSync(dest)) fsSync.copyFileSync(src, dest)
      }
      fsSync.writeFileSync(extraLegacyMarker, JSON.stringify({ migratedAt: new Date().toISOString(), scope }) + '\n', 'utf8')
    } catch (error) { console.error('legacy group/compare migration failed:', error) }
  }
  const initialScope = readSignedInAccountId() || 'guest'
  migrateLegacyData(initialScope)
  migrateExtraLegacyData(initialScope)
  const makeSessionStore = (scope) => createSessionStore({
    statePath: path.join(scopeDir(scope), 'sessions.json'),
    onError: (error) => permissions.audit({ event: 'session-store-write-failed', error: String(error?.message || error) }),
  })
  const makeMemoryStore = (scope) => createMemoryStore({ statePath: path.join(scopeDir(scope), 'memory.json') })
  const roster = createRosterStore({ config, statePath: path.join(stateDir, 'roster.json') })
  const permissions = createPermissionStore({
    statePath: path.join(stateDir, 'permissions.json'),
    workspaceRoot: process.cwd(),
    dataRoot,
    auditPath: path.join(stateDir, 'audit.jsonl'),
  })
  const decisionApprovals = createDecisionApprovalStore({
    statePath: path.join(stateDir, 'decision-approvals.json'),
    onEvent: (event) => permissions.audit(event),
  })
  const decisionLedger = createDecisionLedgerStore({ dataRoot, statePath: path.join(stateDir, 'decision-ledger.json') })
  const decisionOntology = createDecisionOntologyStore({ statePath: path.join(stateDir, 'decision-ontology.json') })
  const agentPresets = createAgentPresetStore({ dataRoot, statePath: path.join(stateDir, 'agent-presets.json') })
  let sessions = makeSessionStore(initialScope)
  const groupRosterIds = new Set((roster.state().models || []).map((m) => m.id))
  const mcpStatusCache = new Map()
  const groupConfig = { ...config, participants: canonicalParticipants(config.participants, groupRosterIds) }
  const makeGroupStore = (scope) => createGroupStore({ statePath: path.join(scopeDir(scope), 'groups.json'), config: groupConfig })
  const makeCompareHistoryStore = (scope) => createCompareHistoryStore({ statePath: path.join(scopeDir(scope), 'compare-history.json') })
  let groups = makeGroupStore(initialScope)
  let memory = makeMemoryStore(initialScope)
  const pluginState = createPluginStateStore({ dataRoot })
  const pluginCatalog = createPluginCatalog({
    dataRoot,
    publicDir,
    url: process.env.MEETINGBOT_PLUGIN_CATALOG_URL || '',
    allowLocal: process.env.MEETINGBOT_PLUGIN_CATALOG_ALLOW_LOCAL === '1',
  })

// Opt-in external skills: the registry is metadata only. Enabling one changes
// the Agent prompt and the plugin market state; it never installs or runs code.
async function externalSkillRows() {
  const enabled = {}
  for (const skill of EXTERNAL_SKILLS) enabled[skill.id] = await pluginState.isEnabled(skill.id)
  return externalSkillsPublic({ root: path.resolve(import.meta.dirname, '..'), enabled })
}
  let compareHistory = makeCompareHistoryStore(initialScope)
  const preferences = createPreferencesStore({ dataRoot })
  const account = createAccountService({ dataRoot })
  let currentScope = initialScope
  /* Sessions and memory are account-scoped. Guest has its own scope so signing
     out cannot expose the previous account's local conversations. */
  const syncAccountScope = async () => {
    const info = await account.get()
    const next = info?.profile?.id ? String(info.profile.id).replace(/[^a-zA-Z0-9_-]/g, '_') : 'guest'
    if (next === currentScope) return false
    if (currentScope === 'guest' && next !== 'guest') copyScopeData('guest', next)
    currentScope = next
    migrateLegacyData(currentScope)
    sessions = makeSessionStore(currentScope)
    memory = makeMemoryStore(currentScope)
    groups = makeGroupStore(currentScope)
    compareHistory = makeCompareHistoryStore(currentScope)
    return true
  }
  const liveRuns = new Map()
  const liveRunsFile = path.join(stateDir, 'live-runs.json')
  const persistLiveRuns = () => {
    try {
      fsSync.mkdirSync(path.dirname(liveRunsFile), { recursive: true })
      const tmp = liveRunsFile + '.tmp'
      const rows = [...liveRuns.values()].map(({ result, ...entry }) => entry)
      fsSync.writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n', 'utf8')
      fsSync.renameSync(tmp, liveRunsFile)
    } catch (error) { console.error('persist live runs failed:', error) }
  }
  try {
    const saved = JSON.parse(fsSync.readFileSync(liveRunsFile, 'utf8'))
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (!entry?.id) continue
      if (entry.status === 'running') {
        entry.status = 'interrupted'
        entry.error = '服务重启：这次会议没有确认完成，不能判定成功或失败'
        entry.interruptedAt = new Date().toISOString()
      }
      liveRuns.set(entry.id, entry)
    }
  } catch (error) { if (error?.code !== 'ENOENT') console.error('load live runs failed:', error) }
  const backgroundJobs = new Map()
  const jobsFile = path.join(dataRoot, 'state', 'jobs.json')
  const persistJobs = () => {
    try {
      fsSync.mkdirSync(path.dirname(jobsFile), { recursive: true })
      const tmp = jobsFile + '.tmp'
      fsSync.writeFileSync(tmp, JSON.stringify([...backgroundJobs.values()].map(({ state, ...job }) => job), null, 2) + '\n', 'utf8')
      fsSync.renameSync(tmp, jobsFile)
    } catch (error) { console.error('persist jobs failed:', error) }
  }
  try {
    const saved = JSON.parse(fsSync.readFileSync(jobsFile, 'utf8'))
    for (const job of Array.isArray(saved) ? saved : []) {
      if (job.status === 'running' || job.status === 'queued') job.status = 'interrupted'
      backgroundJobs.set(job.id, job)
    }
  } catch (error) { if (error?.code !== 'ENOENT') console.error('load jobs failed:', error) }
  const attachJobResult = (job) => {
    if (!job?.parentRunId) return
    for (const folder of ['runs', 'runs-live']) {
      const parentDir = path.join(dataRoot, folder, job.parentRunId)
      if (!fsSync.existsSync(parentDir)) continue
      const outDir = path.join(parentDir, 'job-results')
      fsSync.mkdirSync(outDir, { recursive: true })
      fsSync.writeFileSync(path.join(outDir, `${job.id}.json`), JSON.stringify({ id: job.id, agentId: job.agentId, task: job.task, status: job.status, result: job.result || null, error: job.error || '', finishedAt: job.finishedAt || new Date().toISOString() }, null, 2) + '\n', 'utf8')
      return
    }
  }
  const agentSessions = new Map()
  const AGENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000
  const MAX_AGENT_SESSIONS = 200
  const pruneAgentSessions = () => {
    const now = Date.now()
    for (const [id, session] of agentSessions) {
      if (!Number(session.createdAt) || now - Number(session.createdAt) > AGENT_SESSION_TTL_MS) agentSessions.delete(id)
    }
    while (agentSessions.size > MAX_AGENT_SESSIONS) agentSessions.delete(agentSessions.keys().next().value)
  }
  const rememberAgentSession = (id, data) => {
    pruneAgentSessions()
    agentSessions.set(id, { ...data, createdAt: Date.now() })
    pruneAgentSessions()
  }
  const getAgentSession = (id) => {
    pruneAgentSessions()
    return agentSessions.get(id)
  }
  // Housekeeping policy that has to survive a restart. The panel is the only
  // place that may touch the session file, so the rule is stored next to the
  // data it applies to.
  const policyFile = path.join(stateDir, 'policy.json')
  const readPolicy = () => {
    try {
      const raw = JSON.parse(fsSync.readFileSync(policyFile, 'utf8'))
      return { sessionRetentionDays: Number(raw.sessionRetentionDays) || 0, updatedAt: raw.updatedAt || '' }
    } catch { return { sessionRetentionDays: 0, updatedAt: '' } }
  }
  const writePolicy = (policy) => {
    try {
      fsSync.mkdirSync(path.dirname(policyFile), { recursive: true })
      fsSync.writeFileSync(policyFile, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    } catch { /* the policy is best effort; the UI reports the failure */ }
  }
  // Apply the retention rule that was in force when the app was last closed.
  // 0 days means "never clean up", which is the safe default.
  const startupPolicy = readPolicy()
  if (startupPolicy.sessionRetentionDays > 0) {
    sessions.purgeArchivedOlderThan(startupPolicy.sessionRetentionDays)
  }
  const readBody = async (req, limit = 96 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('request too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const loadDecisionForApproval = async (requested) => {
    const fail = (message, code, status = 400) => {
      const error = new Error(message)
      error.status = status
      error.code = code
      throw error
    }
    const raw = String(requested || '').trim()
    if (!raw) fail('runDir required', 'RUN_DIR_REQUIRED')
    const root = await fs.realpath(path.resolve(process.cwd()))
    let runDir
    try { runDir = await fs.realpath(path.resolve(raw)) }
    catch { fail('run not found', 'RUN_NOT_FOUND', 404) }
    const relative = path.relative(root, runDir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('runDir must identify a run inside the app directory', 'RUN_DIR_OUTSIDE')
    let decision
    try { decision = JSON.parse(await fs.readFile(path.join(runDir, 'decision.json'), 'utf8')) }
    catch { fail('decision.json missing or invalid', 'DECISION_NOT_FOUND', 404) }
    const decisionErrors = validateDecisionDocument(decision)
    if (decisionErrors.length) fail(`decision.json is not a valid decision: ${decisionErrors.slice(0, 5).join('; ')}`, 'DECISION_INVALID', 409)
    return { runDir, decision }
  }
  const ANSWERABILITY_THRESHOLD = 0.5
  const readJsonMaybe = async (file, fallback) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
  }
  // Approval is the execution gate: coverage is computed from certified/manual
  // ontology terms plus claims/decisions, never from auto-mined draft terms.
  const answerabilityForRun = async (runDir, decision) => {
    const runId = path.basename(runDir)
    const proposals = []
    try {
      const dir = path.join(runDir, 'proposals')
      for (const name of (await fs.readdir(dir)).filter((item) => /^P\d+\.json$/.test(item)).sort()) {
        proposals.push(await readJsonMaybe(path.join(dir, name), {}))
      }
    } catch { /* proposals are optional */ }
    const meta = await readJsonMaybe(path.join(runDir, 'meta.json'), {})
    try { decisionOntology.ingest({ runId, runDir, decision, proposals, meta }) } catch { /* keep the gate honest with coverage 0 */ }
    const tasks = decisionTasks(decision)
    const query = tasks.join('；') || String(decision.summary || decision.rationale || '')
    const result = decisionOntology.answerable(query, { runId, includeDrafts: false })
    return {
      ...result,
      threshold: ANSWERABILITY_THRESHOLD,
      required: Number(result.coverage || 0) < ANSWERABILITY_THRESHOLD,
      tasks: tasks.length,
      query,
    }
  }
  const permissionForRun = async (runDir) => {
    const meta = await readJsonMaybe(path.join(runDir, 'meta.json'), {})
    const meeting = PERMISSION_MODES[meta.permissionMode] ? meta.permissionMode : ''
    const current = permissions.current().id
    return { meeting, current, effective: mostRestrictiveMode(meeting || current, current) }
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', `${scheme}://127.0.0.1:${port}`)
      if ((url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')) && req.method !== 'GET') {
        if (!(await pluginState.isEnabled('jobs'))) return send(res, 403, JSON.stringify({ ok: false, error: 'official plugin disabled: jobs' }), 'application/json; charset=utf-8')
      }
      if ((url.pathname === '/api/runs' || url.pathname.startsWith('/api/runs/')) && req.method !== 'GET') {
        if (!(await pluginState.isEnabled('runs'))) return send(res, 403, JSON.stringify({ ok: false, error: 'official plugin disabled: runs' }), 'application/json; charset=utf-8')
      }
      const actualPort = server.address()?.port || port
      const bindHost = String(host || '127.0.0.1').toLowerCase()
      const hostHeader = String(req.headers.host || '').toLowerCase()
      const displayBind = bindHost.includes(':') ? `[${bindHost}]` : bindHost
      const wildcardHost = bindHost === '0.0.0.0' || bindHost === '::'
      const allowedHosts = wildcardHost
        ? null
        : new Set([`${displayBind}:${actualPort}`, `127.0.0.1:${actualPort}`, `localhost:${actualPort}`])
      if (allowedHosts && !allowedHosts.has(hostHeader)) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'host not allowed' }), 'application/json; charset=utf-8')
      }
      const origin = String(req.headers.origin || '').toLowerCase()
      const allowedOrigin = !origin || origin === `${scheme}://${hostHeader}` || (!wildcardHost && [`${scheme}://127.0.0.1:${actualPort}`, `${scheme}://localhost:${actualPort}`, `${scheme}://${displayBind}:${actualPort}`].includes(origin))
      if (origin && !allowedOrigin) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'origin not allowed' }), 'application/json; charset=utf-8')
      }
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
        const index = part.indexOf('=')
        return index >= 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ['', '']
      }))
      const providedRemoteKey = String(req.headers['x-meetingbot-token'] || '').trim()
      const sessionValid = sameToken(cookies.meetingbot_session, panelToken)
        && (!remote || (panelSessions.get(panelToken) || 0) > Date.now())
      const remoteCookieGate = !remote || sessionValid || sameToken(providedRemoteKey, remoteKey)
      const authed = sessionValid || (remote && sameToken(providedRemoteKey, remoteKey))
      if (url.pathname === '/' && remote && !authed && req.method === 'GET') {
        return send(res, 200, '<!doctype html><meta charset="utf-8"><title>MeetingBot</title><form method="post" action="/panel-login"><h1>MeetingBot</h1><input name="token" type="password" autocomplete="current-password" placeholder="panel token" autofocus><button>Enter</button></form>', 'text/html; charset=utf-8')
      }
      if (url.pathname === '/panel-login' && remote && req.method === 'POST') {
        const clientIp = String(req.socket.remoteAddress || '')
        const failure = loginFailures.get(clientIp)
        if (failure && failure.count >= 5 && Date.now() - failure.since < 30000) {
          return send(res, 429, JSON.stringify({ ok: false, error: 'too many login attempts; retry later' }), 'application/json; charset=utf-8')
        }
        const raw = await readBody(req, 16 * 1024)
        let loginToken = ''
        try { loginToken = String(JSON.parse(raw || '{}').token || '') } catch { loginToken = String(new URLSearchParams(raw).get('token') || '') }
        if (!sameToken(loginToken, remoteKey)) {
          const now = Date.now()
          if (!failure || now - failure.since >= 30000) loginFailures.set(clientIp, { count: 1, since: now })
          else failure.count += 1
          return send(res, 401, JSON.stringify({ ok: false, error: 'panel token required' }), 'application/json; charset=utf-8')
        }
        loginFailures.delete(clientIp)
        panelSessions.set(panelToken, Date.now() + sessionTtlMs)
        res.setHeader('Set-Cookie', sessionCookie)
        res.setHeader('Location', '/')
        return send(res, 303, '', 'text/plain; charset=utf-8')
      }
      if (url.pathname.startsWith('/api/') && !authed) {
        return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const chunks = []
        for await (const chunk of req) {
          chunks.push(chunk)
          if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) throw new Error('feedback too large')
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(raw || '{}')
        const message = String(body.message || '').trim()
        if (!message) return send(res, 400, JSON.stringify({ ok: false, error: 'message required' }), 'application/json; charset=utf-8')
        const entry = {
          id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
          category: String(body.category || 'other').slice(0, 40),
          source: body.source === 'agent' ? 'agent' : 'user',
          message: message.slice(0, 4000),
          app: 'MeetingBot',
          version: appVersion || 'unknown',
        }
        await fs.mkdir(path.dirname(feedbackFile), { recursive: true })
        await fs.appendFile(feedbackFile, JSON.stringify(entry) + '\n', 'utf8')
        return send(res, 200, JSON.stringify({ ok: true, id: entry.id, stored: feedbackFile }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/keys') {
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, keys: listSecrets() }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const chunks = []
          for await (const chunk of req) {
            chunks.push(chunk)
            if (chunks.reduce((n, c) => n + c.length, 0) > 32 * 1024) throw new Error('key payload too large')
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const name = String(body.name || '').trim()
          const secret = String(body.secret || '').trim()
          if (!name || !secret) return send(res, 400, JSON.stringify({ ok: false, error: 'name and secret are required' }), 'application/json; charset=utf-8')
          const saved = putSecret(name, secret)
          return send(res, 200, JSON.stringify({ ok: true, saved }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/participant') {
        // Add a user-supplied OpenAI-compatible endpoint to the config roster,
        // so it can participate in meetings instead of being a key-only dead end.
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '')
        const model = String(body.model || '').trim()
        const label = String(body.label || model).trim().slice(0, 80)
        const keyName = String(body.keyName || '').trim()
        let parsed
        try { parsed = new URL(baseUrl) } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl 无效' }), 'application/json; charset=utf-8') }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl 必须是 http(s) 且不能带账号密码' }), 'application/json; charset=utf-8')
        }
        if (!model) return send(res, 400, JSON.stringify({ ok: false, error: 'model 必填' }), 'application/json; charset=utf-8')
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(keyName)) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'keyName 无效' }), 'application/json; charset=utf-8')
        }
        let raw
        try { raw = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) } catch (error) {
          return send(res, 400, JSON.stringify({ ok: false, error: '配置文件无法读取：' + String(error?.message || error) }), 'application/json; charset=utf-8')
        }
        const field = Array.isArray(raw.roster) ? 'roster' : Array.isArray(raw.participants) ? 'participants' : 'roster'
        if (!Array.isArray(raw[field])) raw[field] = []
        const list = raw[field]
        const normalizedBase = baseUrl.toLowerCase()
        const existing = list.find((item) => String(item?.baseUrl || '').replace(/\/+$/, '').toLowerCase() === normalizedBase
          && String(item?.model || '') === model)
        const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'endpoint'
        let id = existing?.id || `custom-${slug}`
        let suffix = 2
        while (!existing && list.some((item) => String(item?.id || '') === id)) id = `custom-${slug}-${suffix++}`
        const participant = {
          ...(existing || {}),
          id,
          label,
          provider: 'openai',
          baseUrl,
          model,
          apiKeyEnv: keyName,
          family: 'custom',
          tags: Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8) : [],
          enabled: true,
        }
        if (existing) Object.assign(existing, participant)
        else list.push(participant)
        const original = JSON.stringify(raw, null, 2) + '\n'
        const tmp = `${configPath}.${process.pid}.tmp`
        const backup = `${configPath}.bak`
        try {
          await fs.writeFile(backup, await fs.readFile(configPath), { encoding: 'utf8' })
          await fs.writeFile(tmp, original, 'utf8')
          await fs.rename(tmp, configPath)
          const check = loadConfig(configPath, { requireKeys: false })
          roster.refresh(check)
          const state = roster.state()
          return send(res, 200, JSON.stringify({ ok: true, id, participant: state.models.find((m) => m.id === id) || null, canonicalRoster: state }), 'application/json; charset=utf-8')
        } catch (error) {
          try { await fs.unlink(tmp) } catch {}
          try { await fs.copyFile(backup, configPath) } catch {}
          return send(res, 400, JSON.stringify({ ok: false, error: '写入配置失败：' + String(error?.message || error) }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/key-info') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '')
        const keyName = String(body.keyName || '').trim()
        if (keyName && !/^[A-Za-z0-9_.-]{1,80}$/.test(keyName)) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'keyName 无效' }), 'application/json; charset=utf-8')
        }
        try {
          const configured = readLiveConfig(false).participants.find((participant) =>
            String(participant.baseUrl || '').replace(/\/+$/, '').toLowerCase() === baseUrl.toLowerCase())
          const vaultKey = keyName ? getSecret(keyName) : ''
          const configKey = String(configured?.apiKey || '')
          const key = vaultKey || configKey
          return send(res, 200, JSON.stringify({
            ok: true,
            hasKey: !!key,
            source: vaultKey ? 'vault' : configKey ? 'config' : 'none',
            tail: key ? key.slice(-4) : '',
            length: key.length,
          }), 'application/json; charset=utf-8')
        } catch (error) {
          return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/discover') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '')
        if (!baseUrl) return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl required' }), 'application/json; charset=utf-8')
        if (!/^https?:\/\//i.test(baseUrl)) return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl must be http(s)' }), 'application/json; charset=utf-8')
        let allowPrivate = false
        try { await assertPublicUrl(baseUrl) } catch {
          let loopback = false
          try { loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(baseUrl).hostname.toLowerCase()) } catch {}
          if (!loopback) return send(res, 400, JSON.stringify({ ok: false, error: 'only public or loopback model endpoints can be discovered' }), 'application/json; charset=utf-8')
          allowPrivate = true
        }
        try {
          const keyName = String(body.keyName || '').trim()
          if (keyName && !/^[A-Za-z0-9_.-]{1,80}$/.test(keyName)) {
            return send(res, 400, JSON.stringify({ ok: false, error: 'keyName 无效' }), 'application/json; charset=utf-8')
          }
          const configured = readLiveConfig(false).participants.find((participant) =>
            String(participant.baseUrl || '').replace(/\/+$/, '').toLowerCase() === baseUrl.toLowerCase())
          const apiKey = String(body.apiKey || (keyName ? getSecret(keyName) : '') || configured?.apiKey || '').trim()
          const response = await requestPublic(new URL(`${baseUrl}/models`), {
            method: 'GET',
            timeoutMs: 12000,
            allowPrivate,
            ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
          })
          const payload = JSON.parse(response.body.toString('utf8') || '{}')
          const models = (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [])
            .map((item) => typeof item === 'string' ? item : String(item.id || item.name || '')).filter(Boolean)
          return send(res, 200, JSON.stringify({ ok: true, models }), 'application/json; charset=utf-8')
        } catch (error) {
          return send(res, 502, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/probe') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '')
        let parsed
        try { parsed = new URL(baseUrl) } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl 无效' }), 'application/json; charset=utf-8') }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl 必须是 http(s) 且不能带账号密码' }), 'application/json; charset=utf-8')
        }
        let allowPrivate = false
        try { await assertPublicUrl(baseUrl) } catch {
          const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
          if (!loopback) return send(res, 400, JSON.stringify({ ok: false, error: '只允许公网或 loopback 模型端点' }), 'application/json; charset=utf-8')
          allowPrivate = true
        }
        const keyName = String(body.keyName || '').trim()
        if (keyName && !/^[A-Za-z0-9_.-]{1,80}$/.test(keyName)) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'keyName 无效' }), 'application/json; charset=utf-8')
        }
        const configured = readLiveConfig(false).participants.find((participant) =>
          String(participant.baseUrl || '').replace(/\/+$/, '').toLowerCase() === baseUrl.toLowerCase())
        // Prefer the key saved from this panel's own vault. The config may
        // contain an older inline/API-key-file value; the user's latest input
        // must not be silently ignored.
        const apiKey = String(body.apiKey || (keyName ? getSecret(keyName) : '') || configured?.apiKey || '').trim()
        if (!apiKey) return send(res, 400, JSON.stringify({ ok: false, error: '没有可用 key' }), 'application/json; charset=utf-8')
        const candidates = [...new Set((Array.isArray(body.candidates) ? body.candidates : [])
          .map((v) => String(v || '').trim()).filter((v) => /^[A-Za-z0-9._:-]{1,128}$/.test(v)))].slice(0, 16)
        if (!candidates.length) return send(res, 400, JSON.stringify({ ok: false, error: '没有候选模型' }), 'application/json; charset=utf-8')
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
        const tested = []
        let authError = false
        const runOne = async (model) => {
          const started = Date.now()
          try {
            const response = await requestPublic(new URL(`${baseUrl}/chat/completions`), {
              method: 'POST',
              headers,
              body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 1 }),
              timeoutMs: 15000,
              allowPrivate,
            })
            const raw = response.body.toString('utf8')
            let content = ''
            let choices = 0
            try {
              const parsed = JSON.parse(raw)
              choices = Array.isArray(parsed?.choices) ? parsed.choices.length : 0
              content = String(parsed?.choices?.[0]?.message?.content || '')
            } catch {}
            if (response.status === 401 || response.status === 403 || /incorrect api key|invalid[_ ]api[_ ]key|unauthor/i.test(raw)) authError = true
            const ok = response.status >= 200 && response.status < 300 && choices > 0
            tested.push({ model, ok, status: response.status, latencyMs: Date.now() - started, error: ok ? '' : raw.slice(0, 180), sample: content.slice(0, 40) })
          } catch (error) {
            tested.push({ model, ok: false, status: 0, latencyMs: Date.now() - started, error: String(error?.message || error).slice(0, 180) })
          }
        }
        for (let i = 0; i < candidates.length; i += 3) {
          await Promise.all(candidates.slice(i, i + 3).map(runOne))
        }
        const anyOk = tested.some((row) => row.ok)
        return send(res, 200, JSON.stringify({ ok: true, tested, available: tested.filter((row) => row.ok).map((row) => row.model), authError: authError && !anyOk }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/provider-test') {
        const chunks = []
        for await (const chunk of req) {
          chunks.push(chunk)
          if (chunks.reduce((n, c) => n + c.length, 0) > 32 * 1024) throw new Error('provider payload too large')
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '')
        const keyName = String(body.keyName || '').trim()
        const configured = keyName
          ? readLiveConfig(false).participants.find((participant) =>
            String(participant.baseUrl || '').replace(/\/+$/, '').toLowerCase() === baseUrl.toLowerCase())
          : null
        if (keyName && !configured) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'keyName can only be tested against its configured baseUrl' }), 'application/json; charset=utf-8')
        }
        let allowPrivate = false
        try { await assertPublicUrl(baseUrl) } catch (error) {
          let local = false
          try {
            const parsed = new URL(baseUrl)
            const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
            local = (configured || loopback) && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
          } catch { local = false }
          if (!local) {
            return send(res, 400, JSON.stringify({ ok: false, error: 'baseUrl is not a public http(s) endpoint' }), 'application/json; charset=utf-8')
          }
          allowPrivate = true
        }
        const apiKey = String(body.apiKey || (keyName ? getSecret(keyName) : '') || '').trim()
        const model = String(body.model || '').trim()
        if (!baseUrl || !apiKey || !model) throw new Error('baseUrl, apiKey and model are required')
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
        const started = Date.now()
        let levels = []
        try {
          const mr = await requestPublic(new URL(`${baseUrl}/models`), { method: 'GET', headers, timeoutMs: 12000, allowPrivate })
          if (mr.status >= 200 && mr.status < 300) {
            const md = JSON.parse(mr.body.toString('utf8') || '{}')
            const hit = (md.data || []).find((m) => m.id === model || m.name === model)
            levels = hit?.effort?.supported_levels || []
          }
        } catch {}
        const cr = await requestPublic(new URL(`${baseUrl}/chat/completions`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 8 }),
          timeoutMs: 25000,
          allowPrivate,
        })
        const text = cr.body.toString('utf8')
        if (cr.status < 200 || cr.status >= 300) {
          return send(res, 200, JSON.stringify({ ok: false, error: `HTTP ${cr.status}: ${text.slice(0, 300)}` }), 'application/json; charset=utf-8')
        }
        let data = {}
        try { data = JSON.parse(text) } catch {}
        const content = data?.choices?.[0]?.message?.content
        return send(res, 200, JSON.stringify({
          ok: true,
          latencyMs: Date.now() - started,
          levels,
          sample: typeof content === 'string' ? content.slice(0, 80) : '',
        }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/roster') {
        roster.refresh(readLiveConfig(false))
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, roster: roster.state() }), 'application/json; charset=utf-8')
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 256 * 1024) || '{}')
          const next = roster.update(body || {})
          return send(res, 200, JSON.stringify({ ok: true, roster: next }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/sessions') {
        if (req.method === 'GET') {
          const includeArchived = url.searchParams.get('archived') !== '0'
          return send(res, 200, JSON.stringify({ ok: true, sessions: sessions.list({ includeArchived }) }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 128 * 1024) || '{}')
          const created = sessions.create(body || {})
          return send(res, 200, JSON.stringify({ ok: true, session: created }), 'application/json; charset=utf-8')
        }
        if (req.method === 'DELETE') {
          // archive=1 is the UI's "clear conversations": recoverable soft delete.
          if (url.searchParams.get('archive') === '1') sessions.archiveAll()
          else sessions.clear()
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        let text = '暂无记录。'
        try {
          const lines = (await fs.readFile(path.join(stateDir, 'audit.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean)
          text = lines.length ? lines.slice(-200).join('\n') : '暂无记录。'
        } catch { /* no audit file yet */ }
        return send(res, 200, JSON.stringify({ ok: true, text }), 'application/json; charset=utf-8')
      }
      // Housekeeping policy that has to survive a restart. The panel is the
      // only place that can touch the session file, so the retention rule is
      // stored next to the data it applies to.
      if (url.pathname === '/api/policy') {
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, policy: readPolicy() }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 16 * 1024) || '{}')
          const days = Math.max(0, Math.min(3650, Number(body.sessionRetentionDays) || 0))
          const policy = { sessionRetentionDays: days, updatedAt: new Date().toISOString() }
          writePolicy(policy)
          const removed = sessions.purgeArchivedOlderThan(days)
          return send(res, 200, JSON.stringify({ ok: true, policy, removed }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/cache/clear') {
        // Only generated artefacts are removed: review screenshots and the
        // snapshot folder. Sessions, decisions and the audit log stay.
        let removed = 0
        for (const dir of [capturesDir, snapshotsDir]) {
          try {
            const entries = await fs.readdir(dir)
            for (const entry of entries) {
              try {
                await fs.rm(path.join(dir, entry), { recursive: true, force: true })
                removed++
              } catch { /* a locked file stays */ }
            }
          } catch { /* the folder does not exist yet */ }
        }
        return send(res, 200, JSON.stringify({ ok: true, removed }), 'application/json; charset=utf-8')
      }
      if (url.pathname.startsWith('/api/sessions/')) {
        const rest = decodeURIComponent(url.pathname.slice('/api/sessions/'.length)).replace(/\/+$/, '')
        if (rest.endsWith('/messages')) {
          const baseId = rest.replace(/\/messages$/, '')
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
            const result = sessions.appendMessage(baseId, body || {})
            if (!result) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), 'application/json; charset=utf-8')
            return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
          }
          return send(res, 405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json; charset=utf-8')
        }
        const id = rest
        if (!id) return send(res, 400, JSON.stringify({ ok: false, error: 'id required' }), 'application/json; charset=utf-8')
        if (req.method === 'GET') {
          const session = sessions.get(id)
          if (!session) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), 'application/json; charset=utf-8')
          return send(res, 200, JSON.stringify({ ok: true, session }), 'application/json; charset=utf-8')
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 256 * 1024) || '{}')
          const updated = sessions.update(id, body || {})
          if (!updated) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), 'application/json; charset=utf-8')
          return send(res, 200, JSON.stringify({ ok: true, session: updated }), 'application/json; charset=utf-8')
        }
        if (req.method === 'DELETE') {
          const removed = sessions.remove(id)
          if (!removed) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), 'application/json; charset=utf-8')
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/permissions') {
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, permissions: permissions.publicState() }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/permissions/mode') {
        const body = JSON.parse(await readBody(req) || '{}')
        const requested = String(body.mode || '')
        if (['workspace', 'self-review', 'full'].includes(requested) && permissions.publicState().workspaceBound !== true) {
          return send(res, 409, JSON.stringify({
            ok: false,
            error: '先绑定工作区文件夹，才能切换到工作区或更高权限',
            code: 'WORKSPACE_BOUND_REQUIRED',
          }), 'application/json; charset=utf-8')
        }
        const next = permissions.setMode({
          mode: requested,
          acceptDisclaimer: body.acceptDisclaimer === true,
        })
        return send(res, 200, JSON.stringify({ ok: true, permissions: next }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/permissions/workspace') {
        const body = JSON.parse(await readBody(req) || '{}')
        try {
          const next = permissions.setWorkspaceRoot(String(body.workspaceRoot || ''))
          return send(res, 200, JSON.stringify({ ok: true, permissions: next }), 'application/json; charset=utf-8')
        } catch (error) {
          return send(res, Number(error?.status) || 400, JSON.stringify({ ok: false, error: String(error?.message || error), code: error?.code || 'INVALID_WORKSPACE_ROOT' }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/tools/state') {
        return send(res, 200, JSON.stringify({
          ok: true,
          workspace: permissions.root,
          cwd: permissions.root,
          permissions: permissions.publicState(),
          python: 'python',
          browser: 'webview',
        }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/tools/fs/')) {
        const body = JSON.parse(await readBody(req, 2 * 1024 * 1024) || '{}')
        const action = url.pathname.slice('/api/tools/fs/'.length)
        let result
        if (action === 'list') result = fsList({ permissions, target: body.path || permissions.root })
        else if (action === 'read') result = fsRead({ permissions, target: body.path })
        else if (action === 'write') {
          try {
            result = fsWrite({
              permissions,
              target: body.path,
              content: body.content,
              confirmToken: body.confirmToken || '',
            })
          } catch (error) {
            if (error?.code === 'CONFIRM_REQUIRED') {
              const issued = permissions.issueConfirmation('overwrite', body.path)
              return send(res, 409, JSON.stringify({ ok: false, code: 'CONFIRM_REQUIRED', error: '覆盖已存在文件需要用户在面板确认', confirmToken: issued.token, expiresAt: issued.expiresAt }), 'application/json; charset=utf-8')
            }
            throw error
          }
        }
        else if (action === 'mkdir') result = fsMkdir({ permissions, target: body.path })
        else if (action === 'delete') result = fsDelete({ permissions, target: body.path, confirm: body.confirm === true })
        else {
          return send(res, 404, JSON.stringify({ ok: false, error: 'unknown fs action: ' + action }), 'application/json; charset=utf-8')
        }
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/tools/python/run') {
        const body = JSON.parse(await readBody(req, 2 * 1024 * 1024) || '{}')
        const result = await pythonRun({ permissions, code: String(body.code || ''), cwd: body.cwd || permissions.root })
        return send(res, 200, JSON.stringify({ ok: result.ok, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/tools/browser/read') {
        const body = JSON.parse(await readBody(req) || '{}')
        const result = await browserRead({ url: body.url, maxChars: body.maxChars })
        return send(res, 200, JSON.stringify({ ok: result.ok, ...result }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/jobs') {
        if (req.method === 'GET') {
          const jobs = [...backgroundJobs.values()].map(({ state, ...job }) => job).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          return send(res, 200, JSON.stringify({ ok: true, jobs }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 256 * 1024) || '{}')
          const task = String(body.task || '').trim()
          const agentId = String(body.agentId || '').trim()
          if (!task || !agentId) return send(res, 400, JSON.stringify({ ok: false, error: 'agentId and task required' }), 'application/json; charset=utf-8')
          let liveConfig
          try { liveConfig = readLiveConfig(true) } catch (error) {
            return send(res, 422, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
          }
          const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const job = { id, agentId, task, parentTaskId: String(body.parentTaskId || ''), parentRunId: String(body.parentRunId || ''), status: 'running', createdAt: new Date().toISOString(), finishedAt: '', result: null, error: '' }
          backgroundJobs.set(id, job);persistJobs()
          runAgentTask({
            config: liveConfig, agentId, task, permissions,
            maxSteps: Math.max(2, Math.min(8, Number(body.maxSteps) || 6)),
            allowQuestions: false,
            shouldAbort: () => backgroundJobs.get(id)?.status === 'cancel-requested',
          }).then((result) => {
            job.status = result?.cancelled || job.status === 'cancel-requested' ? 'cancelled' : (result?.needsInput ? 'needs-input' : (result?.ok ? 'done' : 'failed'))
            job.result = result; job.finishedAt = new Date().toISOString();persistJobs();attachJobResult(job)
          }).catch((error) => { job.status = 'failed'; job.error = String(error?.message || error); job.finishedAt = new Date().toISOString();persistJobs() })
          return send(res, 202, JSON.stringify({ ok: true, job }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length).replace(/\/cancel$/, ''))
        const job = backgroundJobs.get(id)
        if (!job) return send(res, 404, JSON.stringify({ ok: false, error: 'job not found' }), 'application/json; charset=utf-8')
        if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return send(res, 409, JSON.stringify({ ok: false, error: 'job already finished' }), 'application/json; charset=utf-8')
        job.status = 'cancel-requested'; job.error = 'cancellation requested'; persistJobs()
        return send(res, 202, JSON.stringify({ ok: true, job }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/retry$/.test(url.pathname)) {
        const sourceId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length).replace(/\/retry$/, ''))
        const source = backgroundJobs.get(sourceId)
        if (!source) return send(res, 404, JSON.stringify({ ok: false, error: 'job not found' }), 'application/json; charset=utf-8')
        if (['running', 'cancel-requested'].includes(source.status)) return send(res, 409, JSON.stringify({ ok: false, error: '任务仍在运行；先取消或等它结束再重试', code: 'JOB_RUNNING' }), 'application/json; charset=utf-8')
        let retryConfig
        try { retryConfig = readLiveConfig(true) } catch (error) {
          return send(res, 422, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
        }
        const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const job = { id, agentId: source.agentId, task: source.task, parentTaskId: source.id, parentRunId: source.parentRunId || '', retryOf: source.id, status: 'running', createdAt: new Date().toISOString(), finishedAt: '', result: null, error: '' }
        backgroundJobs.set(id, job); persistJobs()
        runAgentTask({ config: retryConfig, agentId: job.agentId, task: job.task, permissions, maxSteps: 6, allowQuestions: false, shouldAbort: () => backgroundJobs.get(id)?.status === 'cancel-requested' })
          .then((result) => { job.status = result?.cancelled || job.status === 'cancel-requested' ? 'cancelled' : (result?.needsInput ? 'needs-input' : (result?.ok ? 'done' : 'failed')); job.result = result; job.finishedAt = new Date().toISOString(); persistJobs();attachJobResult(job) })
          .catch((error) => { job.status = 'failed'; job.error = String(error?.message || error); job.finishedAt = new Date().toISOString(); persistJobs() })
        return send(res, 202, JSON.stringify({ ok: true, job }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = backgroundJobs.get(decodeURIComponent(url.pathname.slice('/api/jobs/'.length)))
        if (!job) return send(res, 404, JSON.stringify({ ok: false, error: 'job not found' }), 'application/json; charset=utf-8')
        return send(res, 200, JSON.stringify({ ok: true, job }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/agent/presets') {
        const type = url.searchParams.get('type') || 'profiles'
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, entries: await agentPresets.list(type) }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
          const entry = await agentPresets.save(body.type || type, body)
          permissions.audit({ event: 'agent-preset-saved', type: body.type || type, id: entry.id, name: entry.name })
          return send(res, 200, JSON.stringify({ ok: true, entry }), 'application/json; charset=utf-8')
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id') || ''
          const removed = await agentPresets.remove(type, id)
          return send(res, removed ? 200 : 404, JSON.stringify({ ok: removed, error: removed ? undefined : 'preset not found' }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt/optimize') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const text = String(body.text || '').trim()
        if (!text) return send(res, 400, JSON.stringify({ ok: false, error: 'prompt required' }), 'application/json; charset=utf-8')
        if (text.length > 20000) return send(res, 400, JSON.stringify({ ok: false, error: 'prompt too long (max 20000 chars)' }), 'application/json; charset=utf-8')
        const agentId = String(body.agentId || '').trim()
        if (!agentId) return send(res, 400, JSON.stringify({ ok: false, error: 'agentId required' }), 'application/json; charset=utf-8')
        const result = await askSingle({
          configPath,
          agentId,
          prompt: text,
          system: 'You are a prompt editor. Rewrite the user prompt so another AI can execute it: preserve the original intent and language; add a clear goal, relevant context, constraints, acceptance criteria, and required output format; remove repetition and vague wording. Return only the improved prompt, with no preface, scoring, or explanation.',
          maxTokens: Math.max(512, Math.min(5000, Number(body.maxTokens) || 2200)),
          timeoutMs: Math.max(15000, Math.min(120000, Number(body.timeoutMs) || 60000)),
        })
        return send(res, 200, JSON.stringify({ ok: true, content: result.content, agent: result.agent, label: result.label, usage: result.usage }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/run') {
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const task = String(body.task || '').trim()
        if (!task) return send(res, 400, JSON.stringify({ ok: false, error: 'task required' }), 'application/json; charset=utf-8')
        const agentOptions = {
          disabledTools: Array.isArray(body.disabledTools) ? body.disabledTools.filter((x) => ['browser', 'files', 'python', 'mcp'].includes(String(x))).map(String) : [],
          allowQuestions: body.allowQuestions !== false,
        }
        const liveConfig = readLiveConfig(true)
        const result = await runAgentTask({
          config: liveConfig,
          agentId: String(body.agentId || ''),
          task,
          permissions,
          maxSteps: Math.max(2, Math.min(8, Number(body.maxSteps) || 6)),
          history: Array.isArray(body.history) ? body.history : [],
          skills: await externalSkillRows(),
          ...agentOptions,
        })
        if (result.needsInput) {
          const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const { state, ...publicResult } = result
          rememberAgentSession(id, { state, maxSteps: Math.max(2, Math.min(8, Number(body.maxSteps) || 6)), ...agentOptions })
          return send(res, 200, JSON.stringify({ ...publicResult, id }), 'application/json; charset=utf-8')
        }
        return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname === '/api/checkpoints') {
        const checkpoints = listCheckpoints({ permissions, limit: url.searchParams.get('limit') })
        return send(res, 200, JSON.stringify({ ok: true, checkpoints }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && /^\/api\/checkpoints\/[^/]+\/restore$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/checkpoints/'.length).replace(/\/restore$/, ''))
        try {
          const body = JSON.parse(await readBody(req, 32 * 1024) || '{}')
          const checkpoint = restoreCheckpoint({ permissions, id, confirm: body.confirm === true })
          return send(res, 200, JSON.stringify({ ok: true, checkpoint }), 'application/json; charset=utf-8')
        } catch (error) {
          const status = Number(error?.status) || 400
          return send(res, status, JSON.stringify({ ok: false, error: String(error?.message || error), code: error?.code || 'CHECKPOINT_RESTORE_FAILED' }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/decisions/approval') {
        if (req.method === 'GET') {
          const { runDir, decision } = await loadDecisionForApproval(url.searchParams.get('runDir'))
          return send(res, 200, JSON.stringify({
            ok: true,
            runDir,
            approval: decisionApprovals.get(runDir, decision),
            availableTasks: decisionTasks(decision),
            blockReason: decisionApprovalBlockReason(decision),
            answerability: await answerabilityForRun(runDir, decision),
            permission: await permissionForRun(runDir),
          }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 128 * 1024) || '{}')
          const { runDir, decision } = await loadDecisionForApproval(body.runDir)
          // Validate the requested scope before the coverage gate so an
          // out-of-scope task still reports APPROVAL_SCOPE_MISMATCH.
          const available = decisionTasks(decision)
          const requested = Array.isArray(body.tasks) ? [...new Set(body.tasks.map((item) => String(item || '').trim()).filter(Boolean))] : []
          if (!requested.length) return send(res, 400, JSON.stringify({ ok: false, error: '至少勾选一项执行任务', code: 'EMPTY_APPROVAL_SCOPE' }), 'application/json; charset=utf-8')
          if (requested.some((task) => !available.includes(task))) return send(res, 400, JSON.stringify({ ok: false, error: '批准范围包含决议之外的任务', code: 'APPROVAL_SCOPE_MISMATCH' }), 'application/json; charset=utf-8')
          const answerability = await answerabilityForRun(runDir, decision)
          const permission = await permissionForRun(runDir)
          const override = body.answerabilityOverride && typeof body.answerabilityOverride === 'object' ? body.answerabilityOverride : null
          const overrideReason = String(override?.reason || '').trim().slice(0, 1000)
          if (answerability.required && override?.confirm !== true) {
            return send(res, 409, JSON.stringify({
              ok: false,
              error: '依据覆盖不足，批准执行需要显式说明为什么仍要执行',
              code: 'ANSWERABILITY_REQUIRED',
              answerability,
            }), 'application/json; charset=utf-8')
          }
          if (answerability.required && !overrideReason) {
            return send(res, 400, JSON.stringify({
              ok: false,
              error: '显式覆盖需要写一句原因',
              code: 'ANSWERABILITY_REASON_REQUIRED',
              answerability,
            }), 'application/json; charset=utf-8')
          }
          const approval = decisionApprovals.approve({
            runDir,
            decision,
            tasks: body.tasks,
            note: body.note,
            allowedPaths: body.allowedPaths,
            answerability: { ...answerability, overridden: answerability.required === true, reason: answerability.required ? overrideReason : '' },
            permissionMode: permission.effective,
          })
          permissions.audit({ event: 'decision-approved', runDir, coverage: answerability.coverage, overridden: answerability.required === true, overrideReason: answerability.required ? overrideReason : '' })
          return send(res, 200, JSON.stringify({ ok: true, approval }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions/file-preview') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const tasks = Array.isArray(body.tasks) ? body.tasks.filter((task) => typeof task === 'string').slice(0, 40) : []
        const files = previewPaths({ root: permissions.root, texts: tasks })
        return send(res, 200, JSON.stringify({ ok: true, files }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions/approval/revoke') {
        const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
        const { runDir, decision } = await loadDecisionForApproval(body.runDir)
        const approval = decisionApprovals.revoke({ runDir, approvalId: String(body.approvalId || ''), decision })
        return send(res, 200, JSON.stringify({ ok: true, approval }), 'application/json; charset=utf-8')
      }
      if ((url.pathname === '/api/ontology' || url.pathname.startsWith('/api/ontology/')) && !(await pluginState.isEnabled('ontology'))) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'official plugin disabled: ontology', code: 'ONTOLOGY_DISABLED' }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/ontology/answerable' && req.method === 'GET') {
        const query = url.searchParams.get('q') || ''
        const result = decisionOntology.answerable(query, { runId: url.searchParams.get('runId') || '' })
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/ontology' && req.method === 'GET') {
        const runId = url.searchParams.get('runId') || ''
        return send(res, 200, JSON.stringify({ ok: true, graph: decisionOntology.forRun(runId) }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/ontology/term' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 32 * 1024) || '{}')
        const term = decisionOntology.addTerm({ label: body.label, definition: body.definition, aliases: body.aliases, runId: body.runId, status: body.status })
        permissions.audit({ event: 'ontology-term-updated', term: term.id, runId: term.runId })
        return send(res, 200, JSON.stringify({ ok: true, term }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/ontology/ingest' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 32 * 1024) || '{}')
        const { runDir, decision } = await loadDecisionForApproval(body.runDir)
        const proposals = []
        try {
          const dir = path.join(runDir, 'proposals')
          for (const name of fsSync.readdirSync(dir).filter((item) => /^P\d+\.json$/.test(item)).sort()) {
            try { proposals.push(JSON.parse(fsSync.readFileSync(path.join(dir, name), 'utf8'))) } catch {}
          }
        } catch {}
        let meta = {}
        try { meta = JSON.parse(fsSync.readFileSync(path.join(runDir, 'meta.json'), 'utf8')) } catch {}
        const graph = decisionOntology.ingest({ runId: path.basename(runDir), runDir, decision, proposals, meta })
        return send(res, 200, JSON.stringify({ ok: true, graph }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/decisions/ledger') {
        if (req.method === 'GET') {
          const entries = await decisionLedger.list({ limit: url.searchParams.get('limit') || 80 })
          return send(res, 200, JSON.stringify({ ok: true, entries }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
          const entry = await decisionLedger.update(body)
          permissions.audit({ event: 'decision-ledger-updated', runId: entry.runId, status: entry.status, reviewAt: entry.reviewAt })
          return send(res, 200, JSON.stringify({ ok: true, entry }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/executor/run') {
        if (!(await pluginState.isEnabled('executor'))) return send(res, 403, JSON.stringify({ ok: false, error: '合议执行器未启用', code: 'EXECUTOR_DISABLED' }), 'application/json; charset=utf-8')
        if (permissions.current().id === 'read-only') return send(res, 403, JSON.stringify({ ok: false, error: '只读模式不允许执行修改；请先提升 Agent 权限', code: 'PERMISSION_DENIED' }), 'application/json; charset=utf-8')
        const body = JSON.parse(await readBody(req, 128 * 1024) || '{}')
        const { runDir, decision } = await loadDecisionForApproval(body.runDir)
        const approval = decisionApprovals.authorize({ runDir, approvalId: String(body.approvalId || ''), decision })
        const executionAnswerability = await answerabilityForRun(runDir, decision)
        if (executionAnswerability.required && approval.answerability?.overridden !== true) {
          return send(res, 409, JSON.stringify({
            ok: false,
            error: '依据覆盖不足；旧批准没有显式覆盖记录，请重新批准并说明原因',
            code: 'ANSWERABILITY_REQUIRED',
            answerability: executionAnswerability,
          }), 'application/json; charset=utf-8')
        }
        const task = buildApprovedExecutorTask({ runDir, decision, approval })
        const agentId = String(body.agentId || decision.foreman || decision.electedForeman || '')
        // A meeting may remember its own mode, but it can only narrow the
        // current machine-wide permission. Downgrade for this execution and
        // restore afterwards; never let a stored meeting mode widen access.
        const runPermission = await permissionForRun(runDir)
        const previousMode = permissions.current().id
        const effectiveMode = mostRestrictiveMode(approval.permissionMode || runPermission.current, previousMode)
        const scoped = effectiveMode !== previousMode
        if (scoped) permissions.setMode({ mode: effectiveMode, acceptDisclaimer: true })
        permissions.audit({ event: 'decision-execution-scope', approvalId: approval.id, runDir, meetingMode: runPermission.meeting, currentMode: previousMode, effectiveMode })
        permissions.audit({ event: 'decision-execution-started', approvalId: approval.id, runDir, agentId })
        let executed = false
        let pausedForQuestion = false
        try {
          const result = await runAgentTask({ config: readLiveConfig(true), agentId, task, permissions, maxSteps: 8, history: [], allowQuestions: true, scope: { allowedPaths: approval.allowedPaths || [] } })
          let publicResult = result
          if (result?.needsInput === true) {
            // Keep the approval in 'executing' and make the question answerable;
            // releasing here would orphan the session and free the approval
            // for a second concurrent execution.
            pausedForQuestion = true
            const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
            const { state, ...rest } = result
            rememberAgentSession(sessionId, { state, maxSteps: 8, disabledTools: [], allowQuestions: true, scope: { allowedPaths: approval.allowedPaths || [] } })
            publicResult = { ...rest, id: sessionId }
          } else if (result?.ok === true) {
            decisionApprovals.markExecuted({ runDir, approvalId: approval.id, summary: result.answer || result.summary || '' })
            executed = true
          }
          permissions.audit({ event: 'decision-execution-finished', approvalId: approval.id, runDir, agentId, ok: result?.ok === true, paused: pausedForQuestion })
          return send(res, 200, JSON.stringify({ ...publicResult, approvalId: approval.id, permissionMode: effectiveMode }), 'application/json; charset=utf-8')
        } catch (error) {
          permissions.audit({ event: 'decision-execution-finished', approvalId: approval.id, runDir, agentId, ok: false, error: String(error?.message || error) })
          throw error
        } finally {
          if (!executed && !pausedForQuestion) decisionApprovals.release({ runDir, approvalId: approval.id, reason: 'execution did not complete' })
          // Only restore the mode we narrowed ourselves, and only if nobody
          // changed it while the executor was running. Never overwrite a
          // choice the owner made mid-execution.
          if (scoped && permissions.current().id === effectiveMode) permissions.setMode({ mode: previousMode, acceptDisclaimer: true })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/answer') {
        const body = JSON.parse(await readBody(req, 256 * 1024) || '{}')
        const id = String(body.id || '')
        const session = getAgentSession(id)
        if (!session) return send(res, 404, JSON.stringify({ ok: false, error: 'agent question not found' }), 'application/json; charset=utf-8')
        if (session.inFlight) return send(res, 409, JSON.stringify({ ok: false, error: '这个回答正在处理中，请勿重复提交', code: 'ANSWER_IN_FLIGHT' }), 'application/json; charset=utf-8')
        session.inFlight = true
        const liveConfig = readLiveConfig(true)
        let result
        try {
        result = await resumeAgentTask({
          config: liveConfig,
          state: session.state,
          answer: String(body.answer || ''),
          approved: body.approved === true,
          permissions,
          maxSteps: session.maxSteps,
          disabledTools: session.disabledTools || [],
          allowQuestions: session.allowQuestions !== false,
          scope: body.scope || session.state?.scope || session.scope || null,
        })
        } catch (error) {
          session.inFlight = false
          throw error
        }
        if (result.needsInput) {
          const { state, ...publicResult } = result
          rememberAgentSession(id, { state, maxSteps: session.maxSteps, disabledTools: session.disabledTools || [], allowQuestions: session.allowQuestions !== false })
          return send(res, 200, JSON.stringify({ ...publicResult, id }), 'application/json; charset=utf-8')
        }
        agentSessions.delete(id)
        return send(res, 200, JSON.stringify({ ...result, id }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/context/compress') {
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const liveConfig = readLiveConfig(true)
        const result = await compressHistory({
          config: liveConfig,
          agentId: String(body.agentId || ''),
          messages: Array.isArray(body.messages) ? body.messages : [],
          targetChars: Math.max(400, Math.min(4000, Number(body.targetChars) || 1800)),
        })
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/revision') {
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const liveConfig = readLiveConfig(true)
        const result = await runRevision({
          config: liveConfig,
          brief: String(body.brief || ''),
          decision: body.decision || {},
          review: body.review || {},
          issues: Array.isArray(body.issues) ? body.issues : [],
          agentId: String(body.agentId || ''),
          agents: Array.isArray(body.agents) ? body.agents : [],
        })
        return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const days = Number(url.searchParams.get('days') || 0)
        const usage = await collectUsage({ dataRoot, days })
        return send(res, 200, JSON.stringify({ ok: true, ...usage }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const runs = await listRuns({ dataRoot })
        return send(res, 200, JSON.stringify({ ok: true, runs }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/decision$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length).replace(/\/decision$/, ''))
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return send(res, 400, JSON.stringify({ ok: false, error: 'invalid run id' }), 'application/json; charset=utf-8')
        let source = ''
        for (const folder of ['runs', 'runs-live']) {
          const candidate = path.join(dataRoot, folder, id)
          if (fsSync.existsSync(path.join(candidate, 'decision.json'))) { source = candidate; break }
        }
        if (!source) return send(res, 404, JSON.stringify({ ok: false, error: 'run decision not found' }), 'application/json; charset=utf-8')
        let decision = null, votes = {}, meta = {}
        try { decision = JSON.parse(fsSync.readFileSync(path.join(source, 'decision.json'), 'utf8')) } catch {}
        try { votes = JSON.parse(fsSync.readFileSync(path.join(source, 'votes.json'), 'utf8')) } catch {}
        try { meta = JSON.parse(fsSync.readFileSync(path.join(source, 'meta.json'), 'utf8')) } catch {}
        if (!decision) return send(res, 422, JSON.stringify({ ok: false, error: 'decision.json is unreadable' }), 'application/json; charset=utf-8')
        const proposals = []
        try {
          for (const name of fsSync.readdirSync(path.join(source, 'proposals')).filter((n) => /^P\d+\.json$/.test(n)).sort()) {
            try { proposals.push(JSON.parse(fsSync.readFileSync(path.join(source, 'proposals', name), 'utf8'))) } catch {}
          }
        } catch {}
        const selected = Array.isArray(meta.selected) ? meta.selected : []
        const foremanId = String(decision.foreman || decision.electedForeman || '')
        const foremanRow = selected.find((row) => row.id === foremanId) || {}
        const result = {
          runDir: source,
          runId: id,
          decision,
          proposals,
          ranked: Array.isArray(votes.ranked) ? votes.ranked : [],
          foreman: { id: foremanId, label: foremanRow.label || foremanId },
          workMode: meta.workMode || decision.workMode || 'council',
          usage: meta.usage || null,
          executionIntent: meta.executionIntent === 'decide' ? 'decide' : 'execute',
          createdAt: meta.createdAt || null,
        }
        return send(res, 200, JSON.stringify({ ok: true, result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && /^\/api\/runs\/[^/]+\/stages$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length).replace(/\/stages$/, ''))
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return send(res, 400, JSON.stringify({ ok: false, error: 'invalid run id' }), 'application/json; charset=utf-8')
        let source = ''
        for (const folder of ['runs', 'runs-live']) {
          const candidate = path.join(dataRoot, folder, id)
          if (fsSync.existsSync(candidate)) { source = candidate; break }
        }
        if (!source) return send(res, 404, JSON.stringify({ ok: false, error: 'run not found' }), 'application/json; charset=utf-8')
        const read = (name) => { try { return fsSync.readFileSync(path.join(source, name), 'utf8').slice(0, 20000) } catch { return '' } }
        let proposals = []
        try { proposals = fsSync.readdirSync(path.join(source, 'proposals')).filter((name) => name.endsWith('.json') && !name.startsWith('_')).slice(0, 8) } catch {}
        const timeline = await readRunTimeline(source)
        return send(res, 200, JSON.stringify({
          ok: true, id,
          timeline,
          stages: {
            proposals: proposals.map((name) => ({ name, content: read(path.join('proposals', name)) })),
            critiques: read('critiques.json'),
            votes: read('votes.json'),
            decision: read('decision.json'),
          },
          children: (() => {
            try { return fsSync.readdirSync(path.join(source, 'job-results')).filter((name) => name.endsWith('.json')).map((name) => { try { return JSON.parse(fsSync.readFileSync(path.join(source, 'job-results', name), 'utf8')) } catch { return null } }).filter(Boolean) } catch { return [] }
          })(),
          validation: (() => {
            const errors = [], warnings = []
            const decisionRaw = read('decision.json')
            if (!decisionRaw) errors.push('decision.json missing')
            else { try { JSON.parse(decisionRaw) } catch { errors.push('decision.json is not valid JSON') } }
            if (!proposals.length) errors.push('no proposal artifacts')
            for (const name of ['critiques.json', 'votes.json']) {
              const raw = read(name)
              if (!raw) warnings.push(`${name} missing`)
              else { try { JSON.parse(raw) } catch { errors.push(`${name} is not valid JSON`) } }
            }
            return { ok: errors.length === 0, errors, warnings }
          })(),
        }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/resume$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length).replace(/\/resume$/, ''))
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return send(res, 400, JSON.stringify({ ok: false, error: 'invalid run id' }), 'application/json; charset=utf-8')
        if ([...liveRuns.values()].some((row) => row.resumedFrom === id && row.status === 'running')) {
          return send(res, 409, JSON.stringify({ ok: false, error: '这场会议已在恢复中，请等它完成', code: 'RESUME_IN_FLIGHT' }), 'application/json; charset=utf-8')
        }
        let source = ''
        for (const folder of ['runs', 'runs-live']) {
          const candidate = path.join(dataRoot, folder, id)
          if (fsSync.existsSync(path.join(candidate, 'meta.json'))) { source = candidate; break }
        }
        if (!source) return send(res, 404, JSON.stringify({ ok: false, error: 'run not found' }), 'application/json; charset=utf-8')
        if (fsSync.existsSync(path.join(source, 'decision.json'))) {
          return send(res, 409, JSON.stringify({ ok: false, error: 'run already has a decision', code: 'RUN_COMPLETE' }), 'application/json; charset=utf-8')
        }
        let meta = {}
        try { meta = JSON.parse(fsSync.readFileSync(path.join(source, 'meta.json'), 'utf8')) } catch {}
        const resumeId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const entry = { id: resumeId, status: 'running', phase: '恢复会议', progress: [], participants: {}, startedAt: new Date().toISOString(), resumedFrom: id }
        liveRuns.set(resumeId, entry); persistLiveRuns()
        const hasVotes = fsSync.existsSync(path.join(source, 'votes.json'))
        Promise.resolve().then(async () => {
          if (hasVotes) {
            const result = await repairDecision({ runDir: source, configPath: meta.config || configPath })
            entry.status = 'done'
            entry.phase = '决议修复完成'
            entry.result = { ...result, runDir: source, resumedFrom: id, resumedMode: 'repair' }
            persistLiveRuns()
            return
          }
          const result = await runMeeting({
            resumeDir: source,
            briefPath: path.join(source, 'brief.md'),
            configPath: meta.config || configPath,
            outDir: path.dirname(source),
            parentRunId: meta.parentRunId || '',
            cache: true,
            selection: meta.selection?.agents?.length ? { ...meta.selection, count: Math.max(2, Array.isArray(meta.selected) && meta.selected.length ? meta.selected.length : meta.selection.agents.length) } : { agents: (Array.isArray(meta.roster) ? meta.roster.map((row) => row.id).filter(Boolean) : []), workMode: meta.workMode || 'council', count: Math.max(2, Array.isArray(meta.roster) ? meta.roster.length : 2) },
            onPhase: (phase) => { entry.phase = phase },
            onProgress: (step) => { if (!Array.isArray(entry.progress)) entry.progress = []; entry.progress = entry.progress.filter((s) => s.phase !== step.phase).concat(step) },
            onParticipant: (person) => { if (!person || !person.agentId) return; const prev = entry.participants[person.agentId] || {}; entry.participants[person.agentId] = { ...prev, ...person, tokens: (Number(prev.tokens) || 0) + (Number(person.tokens) || 0) } },
            shouldAbort: () => entry.cancelRequested === true,
          })
          entry.status = 'done'
          entry.phase = '恢复完成'
          entry.result = { ...result, resumedFrom: id, resumedMode: 'checkpoint' }
          persistLiveRuns()
        }).catch((error) => {
          entry.status = 'failed'
          entry.error = String(error?.message || error)
          entry.errorStage = String(error?.stage || '')
          persistLiveRuns()
        })
        return send(res, 202, JSON.stringify({ ok: true, accepted: true, id: resumeId, resumedFrom: id, mode: hasVotes ? 'repair' : 'checkpoint' }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/retry$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length).replace(/\/retry$/, ''))
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return send(res, 400, JSON.stringify({ ok: false, error: 'invalid run id' }), 'application/json; charset=utf-8')
        let source = ''
        for (const folder of ['runs', 'runs-live']) {
          const candidate = path.join(dataRoot, folder, id)
          if (fsSync.existsSync(path.join(candidate, 'meta.json'))) { source = candidate; break }
        }
        if (!source) return send(res, 404, JSON.stringify({ ok: false, error: 'run not found' }), 'application/json; charset=utf-8')
        try {
          const meta = JSON.parse(fsSync.readFileSync(path.join(source, 'meta.json'), 'utf8'))
          if (!meta.brief || !meta.config) throw new Error('run metadata lacks brief/config paths')
          let retryBrief = meta.brief
          try {
            const childDir = path.join(source, 'job-results')
            const children = fsSync.readdirSync(childDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fsSync.readFileSync(path.join(childDir, name), 'utf8')))
            if (children.length) {
              const base = fsSync.readFileSync(meta.brief, 'utf8')
              const context = children.map((child) => `### ${child.agentId || child.id} (${child.status})\nTask: ${child.task || ''}\nResult: ${JSON.stringify(child.result ?? child.error ?? null).slice(0, 6000)}`).join('\n\n')
              retryBrief = path.join(source, `retry-brief-${Date.now()}.md`)
              fsSync.writeFileSync(retryBrief, `${base}\n\n## 子代理已返回的结果（供本轮继续使用）\n\n${context}\n`, 'utf8')
            }
          } catch { /* no child results */ }
          runMeeting({
            briefPath: retryBrief,
            configPath: meta.config,
            outDir: path.dirname(source),
            parentRunId: id,
            cache: true,
            selection: meta.selection || {},
          }).catch((error) => console.error('run retry failed:', error))
          return send(res, 202, JSON.stringify({ ok: true, accepted: true, id }), 'application/json; charset=utf-8')
        } catch (error) {
          return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/compare/merge') {
        if (!(await pluginState.isEnabled('compare'))) return send(res, 403, JSON.stringify({ ok: false, error: 'official plugin disabled: compare' }), 'application/json; charset=utf-8')
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const result = await mergeCompare({ configPath, prompt: String(body.prompt || ''), results: Array.isArray(body.results) ? body.results : [], mergeAgentId: String(body.mergeAgentId || '') })
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/compare') {
        if (!(await pluginState.isEnabled('compare'))) return send(res, 403, JSON.stringify({ ok: false, error: 'official plugin disabled: compare' }), 'application/json; charset=utf-8')
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const prompt = String(body.prompt || '').trim()
        if (!prompt) return send(res, 400, JSON.stringify({ ok: false, error: 'prompt required' }), 'application/json; charset=utf-8')
        const result = await compareModels({
          configPath,
          prompt,
          agentIds: Array.isArray(body.agentIds) ? body.agentIds : [],
          mergeAgentId: String(body.mergeAgentId || ''),
          merge: body.merge === true,
          maxTokens: body.maxTokens,
          timeoutMs: body.timeoutMs,
        })
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/single') {
        const body = JSON.parse(await readBody(req) || '{}')
        const prompt = String(body.prompt || '').trim()
        if (!prompt) return send(res, 400, JSON.stringify({ ok: false, error: 'prompt required' }), 'application/json; charset=utf-8')
        const result = await askSingle({
          configPath,
          agentId: String(body.agentId || ''),
          prompt,
          system: body.system,
          maxTokens: body.maxTokens,
          timeoutMs: body.timeoutMs,
        })
        return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/groups/plan' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}')
        return send(res, 200, JSON.stringify({ ok: true, ...groups.plan(String(body.brief || ''), Array.isArray(body.members) ? body.members : []) }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/groups') {
        if (req.method === 'GET') {
          return send(res, 200, JSON.stringify({ ok: true, groups: await groups.list() }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}')
          const group = await groups.create({
            name: body.name,
            brief: body.brief,
            mode: body.mode,
            members: body.members,
            personas: body.personas,
            sharedMemory: body.sharedMemory === true,
          })
          return send(res, 200, JSON.stringify({ ok: true, group }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname.startsWith('/api/groups/')) {
        const rest = decodeURIComponent(url.pathname.slice('/api/groups/'.length)).replace(/\/+$/, '')
        const parts = rest.split('/')
        const id = parts[0]
        if (req.method === 'GET' && parts.length === 1) {
          const group = await groups.get(id)
          if (!group) return send(res, 404, JSON.stringify({ ok: false, error: 'group not found' }), 'application/json; charset=utf-8')
          return send(res, 200, JSON.stringify({ ok: true, group }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST' && parts[1] === 'messages') {
          const body = JSON.parse(await readBody(req) || '{}')
          const result = await groups.send(id, body.text || body.message, { mode: body.mode, memberIds: body.memberIds, sharedMemory: body.useMemory === false ? [] : (await memory.list()).filter((entry) => entry.status === 'approved' && entry.core === true) })
          return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
        }
        if (req.method === 'POST' && parts[1] === 'convert') {
          const brief = await groups.convertBrief(id)
          return send(res, 200, JSON.stringify({ ok: true, brief }), 'application/json; charset=utf-8')
        }
        if (req.method === 'DELETE' && parts.length === 1) {
          return send(res, 200, JSON.stringify({ ok: true, removed: await groups.remove(id) }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/account') {
        if (req.method === 'GET') { await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, account: await account.get() }), 'application/json; charset=utf-8') }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
          try {
            if (body.action === 'configure') { const result = await account.configure(body); await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, account: result }), 'application/json; charset=utf-8') }
            if (body.action === 'signup') { const result = await account.signUp(body); const scopeChanged = await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, ...result, scopeChanged }), 'application/json; charset=utf-8') }
            if (body.action === 'signin') { const result = await account.signIn(body); const scopeChanged = await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, ...result, scopeChanged }), 'application/json; charset=utf-8') }
            if (body.action === 'signout') { const result = await account.signOut(); const scopeChanged = await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, ...result, scopeChanged }), 'application/json; charset=utf-8') }
            if (body.action === 'oauthStart') return send(res, 200, JSON.stringify({ ok: true, ...(await account.oauthStart(body.provider)) }), 'application/json; charset=utf-8')
            if (body.action === 'resetLocal') { const result = await account.resetLocal(); const scopeChanged = await syncAccountScope(); return send(res, 200, JSON.stringify({ ok: true, ...result, scopeChanged }), 'application/json; charset=utf-8') }
            if (body.action === 'pushSettings') return send(res, 200, JSON.stringify({ ok: true, row: await account.pushSettings(body.payload || {}, { replace: body.replace === true }) }), 'application/json; charset=utf-8')
            if (body.action === 'pullSettings') return send(res, 200, JSON.stringify({ ok: true, row: await account.pullSettings() }), 'application/json; charset=utf-8')
            return send(res, 400, JSON.stringify({ ok: false, error: 'unknown account action' }), 'application/json; charset=utf-8')
          } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
        }
      }
      if (url.pathname === '/api/workspace/context' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req, 256 * 1024) || '{}')
          const result = await collectWorkspaceContext({ root: body.root, brief: body.brief, maxFiles: body.maxFiles })
          return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
        } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
      }
      if (url.pathname === '/api/preferences') {
        if (req.method === 'GET') return send(res, 200, JSON.stringify({ ok: true, preferences: await preferences.get() }), 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
          try { return send(res, 200, JSON.stringify({ ok: true, preferences: await preferences.patch(body) }), 'application/json; charset=utf-8') }
          catch (error) { return send(res, 500, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
        }
      }
      if (url.pathname === '/api/compare/history') {
        if (req.method === 'GET') return send(res, 200, JSON.stringify({ ok: true, entries: await compareHistory.list() }), 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
          try { return send(res, 200, JSON.stringify({ ok: true, entry: await compareHistory.add(body) }), 'application/json; charset=utf-8') }
          catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
        }
      }
      if (url.pathname === '/api/plugins/catalog') {
        if (req.method === 'GET') {
          const state = await pluginCatalog.current()
          const meta = await pluginCatalog.info()
          return send(res, 200, JSON.stringify({ ...state.catalog, meta: { source: meta.source, version: meta.version, updated: meta.updated, count: meta.count, sha256: meta.sha256, fetchedAt: meta.fetchedAt, sourceUrl: meta.sourceUrl } }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/plugins/catalog/refresh' && req.method === 'POST') {
        try {
          const meta = await pluginCatalog.refresh()
          return send(res, 200, JSON.stringify({ ok: true, meta }), 'application/json; charset=utf-8')
        } catch (error) {
          let fallback = null
          try { const info = await pluginCatalog.info(); fallback = { source: info.source, version: info.version, count: info.count } } catch { /* ignore */ }
          return send(res, 502, JSON.stringify({ ok: false, error: String(error?.message || error), fallback }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/plugins/registry') {
        if (req.method === 'GET') return send(res, 200, JSON.stringify({ ok: true, plugins: await pluginState.listThirdParty() }), 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 32 * 1024) || '{}')
          try {
            if (body.action === 'remove') return send(res, 200, JSON.stringify({ ok: true, removed: await pluginState.removeThirdParty(body.id) }), 'application/json; charset=utf-8')
            if (body.action === 'toggle') return send(res, 200, JSON.stringify({ ok: true, plugin: await pluginState.setThirdPartyEnabled(body.id, body.enabled === true) }), 'application/json; charset=utf-8')
            return send(res, 200, JSON.stringify({ ok: true, plugin: await pluginState.registerThirdParty(body.id, body) }), 'application/json; charset=utf-8')
          } catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        return send(res, 200, JSON.stringify({ ok: true, skills: await externalSkillRows() }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/skills/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/skills/'.length)).replace(/\/+$/, '')
        const skill = EXTERNAL_SKILLS.find((row) => row.id === id)
        if (!skill) return send(res, 404, JSON.stringify({ ok: false, error: 'unknown external skill' }), 'application/json; charset=utf-8')
        const body = JSON.parse(await readBody(req, 8 * 1024) || '{}')
        await pluginState.setOfficial(id, body.enabled === true)
        const updated = (await externalSkillRows()).find((row) => row.id === id)
        permissions.audit({ event: 'external-skill-toggle', skill: id, enabled: updated.enabled })
        return send(res, 200, JSON.stringify({ ok: true, skill: updated }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/plugins/state') {        if (req.method === 'GET') return send(res, 200, JSON.stringify({ ok: true, plugins: await pluginState.list() }), 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 16 * 1024) || '{}')
          if (body.action === 'uninstall') return send(res, 403, JSON.stringify({ ok: false, error: 'official plugins cannot be uninstalled' }), 'application/json; charset=utf-8')
          if (!body.id || typeof body.enabled !== 'boolean') return send(res, 400, JSON.stringify({ ok: false, error: 'id and enabled required' }), 'application/json; charset=utf-8')
          try { return send(res, 200, JSON.stringify({ ok: true, plugin: await pluginState.setOfficial(body.id, body.enabled) }), 'application/json; charset=utf-8') }
          catch (error) { return send(res, 400, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8') }
        }
      }
      if (url.pathname === '/api/memory' || url.pathname === '/api/compare' || url.pathname === '/api/compare/merge' || url.pathname === '/api/jobs' || url.pathname === '/api/runs' || url.pathname.startsWith('/api/runs/')) {
        const pluginId = url.pathname.startsWith('/api/memory') ? 'memory' : url.pathname.startsWith('/api/compare') ? 'compare' : url.pathname.startsWith('/api/jobs') ? 'jobs' : 'runs'
        if (!(await pluginState.isEnabled(pluginId))) return send(res, 403, JSON.stringify({ ok: false, error: `official plugin disabled: ${pluginId}` }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/memory') {
        if (req.method === 'GET') return send(res, 200, JSON.stringify({ ok: true, entries: await memory.list() }), 'application/json; charset=utf-8')
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024) || '{}')
          if (body.delete || body.action === 'delete') return send(res, 200, JSON.stringify({ ok: true, removed: await memory.remove(body.delete || body.id) }), 'application/json; charset=utf-8')
          if (body.action === 'approve' || body.action === 'reject') return send(res, 200, JSON.stringify({ ok: true, entry: await memory.update(body.id, { status: body.action === 'approve' ? 'approved' : 'rejected' }) }), 'application/json; charset=utf-8')
          if (body.action === 'update') return send(res, 200, JSON.stringify({ ok: true, entry: await memory.update(body.id, body.patch || {}) }), 'application/json; charset=utf-8')
          return send(res, 200, JSON.stringify({ ok: true, entry: await memory.add(body, body.source) }), 'application/json; charset=utf-8')
        }
      }
      if (url.pathname === '/api/mcp/status') {
        const live = readLiveConfig(false)
        const wantsTools = url.searchParams.get('tools') === '1'
        const cacheKey = JSON.stringify({ mcp: live.mcp || null, permission: permissions.current().id, tools: wantsTools })
        const cached = mcpStatusCache.get(cacheKey)
        if (cached && Date.now() - cached.at < 15000) {
          return send(res, 200, JSON.stringify({ ok: true, ...cached.status, tools: cached.tools }), 'application/json; charset=utf-8')
        }
        const manager = createMcpManager({ config: live, permission: permissions.current().id })
        try {
          const status = await manager.status()
          const tools = manager.enabled && wantsTools
            ? (await manager.listTools()).map((tool) => ({ server: tool.server, name: tool.name, description: tool.description || '', readOnly: tool.readOnly === true, error: tool.error || '' }))
            : []
          mcpStatusCache.set(cacheKey, { at: Date.now(), status, tools })
          if (mcpStatusCache.size > 16) mcpStatusCache.delete(mcpStatusCache.keys().next().value)
          return send(res, 200, JSON.stringify({ ok: true, ...status, tools }), 'application/json; charset=utf-8')
        } finally {
          await manager.close()
        }
      }
      if (url.pathname === '/api/vision/capabilities') {
        return send(res, 200, JSON.stringify({
          ok: true,
          reviewers: visionCandidates(readLiveConfig(false)).map((participant) => ({ id: participant.id, label: participant.label, model: participant.model })),
          capturesDir,
          snapshotsDir,
          workspace: process.cwd(),
          defaultTarget: path.resolve(process.cwd(), 'public'),
        }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/vision/review') {
        const body = JSON.parse(await readBody(req) || '{}')
        const imagePath = String(body.imagePath || '').trim()
        if (!imagePath) return send(res, 400, JSON.stringify({ ok: false, error: 'imagePath required' }), 'application/json; charset=utf-8')
        const liveConfig = readLiveConfig(true)
        const result = await reviewImage({
          config: liveConfig,
          imagePath,
          criteria: body.criteria,
          agentIds: Array.isArray(body.agentIds) ? body.agentIds : [],
        })
        return send(res, 200, JSON.stringify({ ok: result.ok, ...result }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/vision/guard') {
        return send(res, 410, JSON.stringify({ ok: false, error: 'file rollback is retired; use /api/revision (rollback to foreman)' }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && url.pathname === '/api/meetings/followup-brief') {
        const body = JSON.parse(await readBody(req, 512 * 1024) || '{}')
        const requested = String(body.runDir || '').trim()
        if (!requested) return send(res, 400, JSON.stringify({ ok: false, error: 'runDir required' }), 'application/json; charset=utf-8')
        const parent = path.resolve(requested)
        const root = path.resolve(process.cwd())
        if (parent !== root && !parent.startsWith(root + path.sep)) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'runDir must be inside the app directory' }), 'application/json; charset=utf-8')
        }
        try {
          const result = await buildFollowupBriefFromRun(parent, String(body.extra || ''))
          return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8')
        } catch (error) {
          return send(res, 404, JSON.stringify({ ok: false, error: String(error?.message || error) }), 'application/json; charset=utf-8')
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/meetings/start') {
        const body = JSON.parse(await readBody(req) || '{}')
        const brief = String(body.brief || '').trim()
        if (!brief) return send(res, 400, JSON.stringify({ ok: false, error: 'brief required' }), 'application/json; charset=utf-8')
        const id = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        // The output directory is a single relative folder name inside the
        // workspace. Absolute paths, separators and ".." are rejected here so
        // a UI setting can never widen the path boundary.
        const requestedDir = String(body.runDir || 'runs-live').trim()
        const safeDir = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,59}$/.test(requestedDir) && !requestedDir.includes('..')
          ? requestedDir : 'runs-live'
        const liveDir = path.resolve(process.cwd(), safeDir)
        const root = path.resolve(process.cwd())
        if (liveDir !== root && !liveDir.startsWith(root + path.sep)) {
          return send(res, 400, JSON.stringify({ ok: false, error: '运行目录必须在应用目录内' }), 'application/json; charset=utf-8')
        }
        const mock = body.mock === true
        const exportFormat = ['md', 'html', 'both'].includes(String(body.exportFormat || '')) ? String(body.exportFormat) : 'both'
        await fs.mkdir(liveDir, { recursive: true })
        const briefPath = path.join(liveDir, `${id}.brief.md`)
        await fs.writeFile(briefPath, brief + '\n', 'utf8')
        const selection = roster.meetingSelection({
          ...(body.selection || {}),
          workMode: body.workMode || body.selection?.workMode,
        })
        const requestedForemanId = String(body.foremanId || body.selection?.foremanId || '').trim()
        if (requestedForemanId && !selection.agents.includes(requestedForemanId)) {
          return send(res, 400, JSON.stringify({ ok: false, error: '指定的主 Bot 必须在本场已选模型内' }), 'application/json; charset=utf-8')
        }
        if (requestedForemanId) selection.foremanId = requestedForemanId
        const entry = { id, status: 'running', startedAt: new Date().toISOString(), briefPath, brief: brief.slice(0, 2000), outDir: liveDir, selection, exportFormat, permissionMode: (() => { const requested = String(body.permissionMode || ''); return PERMISSION_MODES[requested] ? requested : permissions.current().id })(), interjections: [], progress: [], participants: {} }
        liveRuns.set(id, entry);persistLiveRuns()
        runMeeting({ briefPath, configPath, outDir: liveDir, mock, mockDelayMs: Math.max(0, Math.min(5000, Number(body.mockDelayMs) || 0)), mockSize: Math.max(0, Math.min(200, Number(body.mockSize) || 0)), parentRunId: String(body.parentRunId || ''), cache: body.noCache !== true, executionIntent: body.executionIntent === 'execute' ? 'execute' : 'decide', permissionMode: entry.permissionMode, selection, onPhase: (phase) => { entry.phase = phase; persistLiveRuns() }, onProgress: (step) => { if (!Array.isArray(entry.progress)) entry.progress = []; entry.progress = entry.progress.filter((s) => s.phase !== step.phase).concat(step); persistLiveRuns() }, onParticipant: (person) => { if (!person || !person.agentId) return; if (!entry.participants || typeof entry.participants !== 'object' || Array.isArray(entry.participants)) entry.participants = {}; const prev = entry.participants[person.agentId] || {}; entry.participants[person.agentId] = { ...prev, ...person, tokens: (Number(prev.tokens) || 0) + (Number(person.tokens) || 0), at: Date.now() }; persistLiveRuns() }, getInterjections: () => entry.interjections || [], shouldAbort: () => entry.cancelRequested === true })
          .then(async (result) => {
            // "导出格式" controls which report files are actually produced.
            const runResultDir = path.resolve(result.runDir)
            try {
              if (exportFormat === 'md') await fs.unlink(path.join(runResultDir, 'report.html'))
              else if (exportFormat === 'html') await fs.unlink(path.join(runResultDir, 'decision.md'))
            } catch { /* a report may not exist; not fatal */ }
            entry.status = 'done'
            entry.finishedAt = new Date().toISOString()
            entry.result = { ...result, runDir: runResultDir }
            persistLiveRuns()
          })
          .catch((error) => {
            entry.status = error?.code === 'MEETING_CANCELLED' ? 'cancelled' : 'failed'
            entry.finishedAt = new Date().toISOString()
            entry.error = String(error?.message || error)
            entry.errorStage = String(error?.stage || '')
            entry.errorAgent = String(error?.agentId || error?.agentLabel || '')
            entry.errorAgents = selection.agents || []
            persistLiveRuns()
          })
        return send(res, 202, JSON.stringify({ ok: true, id, status: 'running', outDir: liveDir, exportFormat }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname.endsWith('/events') && url.pathname.startsWith('/api/meetings/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/meetings/'.length).replace(/\/events$/, ''))
        const entry = liveRuns.get(id)
        if (!entry) return send(res, 404, JSON.stringify({ ok: false, error: 'meeting not found' }), 'application/json; charset=utf-8')
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const emit = () => {
          try {
            res.write(`event: progress\ndata: ${JSON.stringify({ status: entry.status, phase: entry.phase || '', progress: entry.progress || [], participants: entry.participants || {}, result: entry.result || null, error: entry.error || null })}\n\n`)
          } catch { /* client disconnected */ }
        }
        emit()
        const timer = setInterval(() => {
          emit()
          if (entry.status !== 'running') {
            clearInterval(timer)
            res.end()
          }
        }, 250)
        req.on('close', () => clearInterval(timer))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/meetings/live') {
        const rows = [...liveRuns.values()]
          .filter((entry) => entry.status === 'running' || entry.status === 'interrupted')
          .map(({ result, ...entry }) => entry)
        return send(res, 200, JSON.stringify({ ok: true, meetings: rows }), 'application/json; charset=utf-8')
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/meetings/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/meetings/'.length))
        const entry = liveRuns.get(id)
        if (!entry) return send(res, 404, JSON.stringify({ ok: false, error: 'meeting not found' }), 'application/json; charset=utf-8')
        return send(res, 200, JSON.stringify({ ok: true, ...entry }), 'application/json; charset=utf-8')
      }
      if (req.method === 'POST' && /^\/api\/meetings\/[^/]+\/cancel$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.slice('/api/meetings/'.length).replace(/\/cancel$/, ''))
        const entry = liveRuns.get(id)
        if (!entry) return send(res, 404, JSON.stringify({ ok: false, error: 'meeting not found' }), 'application/json; charset=utf-8')
        if (entry.status !== 'running') return send(res, 409, JSON.stringify({ ok: false, error: 'meeting is not running', status: entry.status }), 'application/json; charset=utf-8')
        entry.cancelRequested = true
        entry.phase = '停止中（当前模型调用结束后生效）'
        return send(res, 202, JSON.stringify({ ok: true, cancelRequested: true, id }), 'application/json; charset=utf-8')
      }
      // Mid-meeting owner interjection. Queued onto the live run so the
      // critique / vote / decision prompts include it ("enters the next round").
      if (req.method === 'POST' && url.pathname.startsWith('/api/meetings/') && url.pathname.endsWith('/interject')) {
        const id = decodeURIComponent(url.pathname.slice('/api/meetings/'.length).replace(/\/interject$/, ''))
        const entry = liveRuns.get(id)
        if (!entry) return send(res, 404, JSON.stringify({ ok: false, error: 'meeting not found' }), 'application/json; charset=utf-8')
        if (entry.status !== 'running') {
          return send(res, 409, JSON.stringify({ ok: false, error: 'meeting is not running; the note was not included' }), 'application/json; charset=utf-8')
        }
        const body = JSON.parse(await readBody(req) || '{}')
        const text = String(body.text || '').trim().slice(0, 2000)
        if (!text) return send(res, 400, JSON.stringify({ ok: false, error: 'text required' }), 'application/json; charset=utf-8')
        if (!Array.isArray(entry.interjections)) entry.interjections = []
        entry.interjections.push({ text, at: new Date().toISOString() })
        if (entry.interjections.length > 20) entry.interjections = entry.interjections.slice(-20)
        return send(res, 200, JSON.stringify({ ok: true, queued: entry.interjections.length }), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/api/config') {
        let version = ''
        try { version = String(JSON.parse(await fs.readFile(path.resolve(here, '..', 'package.json'), 'utf8')).version || '') } catch {}
        const liveConfig = readLiveConfig(false)
        roster.refresh(liveConfig)
        const presets = Object.fromEntries(Object.entries(liveConfig.presets || {}).map(([id, p]) => [id, {
          label: p.label || id,
          agents: p.agents || [],
          count: p.count || liveConfig.selection.count,
          thinking: p.thinking || 'default',
        }]))
        return send(res, 200, JSON.stringify({
          name: liveConfig.name,
          version,
          defaultPreset: liveConfig.selection.defaultPreset || null,
          presets,
          roster: publicRoster(liveConfig),
          canonicalRoster: roster.state(),
        }, null, 2), 'application/json; charset=utf-8')
      }
      if (url.pathname === '/health') return send(res, 200, 'ok')
      // Browsers ask for /favicon.ico on every load; serve the app icon so a
      // missing default request never turns into a 500 in the console.
      const file = url.pathname === '/' ? 'panel.html'
        : url.pathname === '/companion' ? 'companion.html'
          : url.pathname === '/favicon.ico' ? 'heyi.ico'
            : url.pathname.replace(/^\/+/, '')
      if (!/^[a-z0-9._-]+$/i.test(file)) return send(res, 404, 'not found')
      let data
      try {
        data = await fs.readFile(path.join(publicDir, file))
      } catch {
        return send(res, 404, 'not found')
      }
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8'
            : file.endsWith('.json') ? 'application/json; charset=utf-8'
              : file.endsWith('.png') ? 'image/png'
              : file.endsWith('.ico') ? 'image/x-icon'
                : file.endsWith('.svg') ? 'image/svg+xml'
                  : 'application/octet-stream'
      if (file.endsWith('.html')) {
        if (remoteCookieGate) {
          panelSessions.set(panelToken, Date.now() + sessionTtlMs)
          res.setHeader('Set-Cookie', sessionCookie)
        }
        else return send(res, 401, JSON.stringify({ ok: false, error: 'panel token required' }), 'application/json; charset=utf-8')
      }
      res.setHeader('X-Content-Type-Options', 'nosniff')
      // The companion is explicitly allowed to render inside the main panel's
      // same-origin split pane. Every other page keeps the DENY default.
      res.setHeader('X-Frame-Options', url.pathname === '/companion' ? 'SAMEORIGIN' : 'DENY')
      return send(res, 200, data, type)
    } catch (error) {
      const status = Number(error?.status) || 500
      return send(res, status, JSON.stringify({
        ok: false,
        error: String(error?.message || error),
        code: error?.code || '',
      }), 'application/json; charset=utf-8')
    }
  }
  const server = useTls ? https.createServer(tlsOptions, handler) : http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actualPort = server.address().port
      const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
      resolve({ server, port: actualPort, host, url: `${scheme}://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${actualPort}`, config, token: remoteKey || null })
    })
  })
}
