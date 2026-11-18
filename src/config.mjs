import fs from 'node:fs'
import path from 'node:path'
import { getSecret } from './key-vault.mjs'
import { resolveParticipant, vaultEnvFor } from './model-aliases.mjs'

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function readKey(p, baseDir) {
  if (p.apiKey) return String(p.apiKey)
  const apiKeyEnv = String(p.apiKeyEnv || '').trim()
  if (apiKeyEnv && process.env[apiKeyEnv]) return process.env[apiKeyEnv]
  // A key saved from the settings panel lives in the local encrypted vault.
  // Resolve it under the same env name the example config references, then
  // fall back to the canonical model's env name. This keeps local configs
  // (which use apiKeyFile) and example configs (apiKeyEnv) on one path.
  const vaultNames = [apiKeyEnv, p.apiKeyVaultName, vaultEnvFor(p.id), vaultEnvFor(p.model)]
    .map((name) => String(name || '').trim()).filter(Boolean)
  for (const name of [...new Set(vaultNames)]) {
    const stored = getSecret(name)
    if (stored) return stored
  }
  if (!p.apiKeyFile) return ''
  const keyFile = path.isAbsolute(p.apiKeyFile) ? p.apiKeyFile : path.resolve(baseDir, p.apiKeyFile)
  if (!fs.existsSync(keyFile)) return ''
  const lines = fs.readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines.find((line) => /^sk-/.test(line)) || lines[0] || ''
}

export function loadConfig(configPath, { requireKeys = true } = {}) {
  const abs = path.resolve(configPath)
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''))
  const baseDir = path.dirname(abs)
  const roster = Array.isArray(raw.roster) ? raw.roster : (Array.isArray(raw.participants) ? raw.participants : [])
  if (!roster.length) throw new Error('config needs a non-empty roster (or participants)')
  const seen = new Set()
  const participants = roster.map((p, index) => {
    const id = String(p.id || '').trim()
    const label = String(p.label || id || `agent-${index + 1}`).trim()
    const baseUrl = String(p.baseUrl || '').trim()
    const model = String(p.model || '').trim()
    if (!id || seen.has(id)) throw new Error(`participant id missing or duplicated: ${id}`)
    seen.add(id)
    if (!baseUrl || !model) throw new Error(`participant ${id} needs baseUrl and model`)
    const apiKey = readKey(p, baseDir)
    return {
      id,
      label,
      provider: p.provider || 'openai',
      baseUrl,
      model,
      apiKey,
      hasKey: !!apiKey,
      enabled: p.enabled !== false,
      tags: normalizeList(p.tags),
      costTier: Math.max(1, Math.min(5, Number(p.costTier) || 3)),
      qualityTier: Math.max(1, Math.min(5, Number(p.qualityTier) || 3)),
      family: String(p.family || p.provider || 'openai'),
      temperature: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : undefined,
      noThink: p.noThink === true,
      jsonMode: p.jsonMode === true,
    }
  })
  if (requireKeys && !participants.some((p) => p.apiKey)) throw new Error('config has no API key (env, vault or apiKeyFile)')
  return {
    path: abs,
    name: String(raw.name || 'meeting'),
    participants,
    selection: {
      count: Math.max(2, Math.min(participants.filter((p) => p.enabled).length, Number(raw.selection?.count) || 4)),
      include: normalizeList(raw.selection?.include),
      exclude: normalizeList(raw.selection?.exclude),
      requireTags: normalizeList(raw.selection?.requireTags),
      maxCostTier: Math.max(1, Math.min(5, Number(raw.selection?.maxCostTier) || 5)),
      fallbacks: normalizeList(raw.selection?.fallbacks),
      defaultPreset: String(raw.selection?.defaultPreset || '').trim(),
    },
    presets: raw.presets && typeof raw.presets === 'object' ? raw.presets : {},
    quorum: {
      min: Math.max(2, Math.min(participants.length, Number(raw.quorum?.min) || 3)),
      allowDegraded: raw.quorum?.allowDegraded !== false,
    },
    dimensionWeights: (() => {
      const weight = (key, fallback) => {
        const rawValue = raw.dimensionWeights?.[key]
        const value = Number(rawValue)
        return Number.isFinite(value) && rawValue !== '' && rawValue != null ? Math.max(0, Math.min(1, value)) : fallback
      }
      return { architecture: weight('architecture', 0.45), aesthetics: weight('aesthetics', 0.35), security: weight('security', 0.20) }
    })(),
    computerAccess: {
      enabled: raw.computerAccess?.enabled === true,
      mode: String(raw.computerAccess?.mode || 'worktree-only'),
      requiresOwnerApproval: raw.computerAccess?.requiresOwnerApproval !== false,
      tools: normalizeList(raw.computerAccess?.tools),
    },
    mcp: {
      enabled: raw.mcp?.enabled === true,
      timeoutMs: Math.max(1000, Math.min(120000, Number(raw.mcp?.timeoutMs) || 20000)),
      servers: (Array.isArray(raw.mcp?.servers) ? raw.mcp.servers : [])
        .map((server) => ({
          id: String(server?.id || '').trim(),
          label: String(server?.label || server?.id || '').trim(),
          command: String(server?.command || '').trim(),
          args: Array.isArray(server?.args) ? server.args.map(String) : [],
          cwd: String(server?.cwd || '').trim(),
          env: server?.env && typeof server.env === 'object' ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [String(k), String(v)])) : {},
          enabled: server?.enabled !== false,
          readOnly: server?.readOnly === true,
        }))
        .filter((server) => server.id && server.command),
    },
    cache: {
      enabled: raw.cache?.enabled !== false,
      ttlDays: Math.max(1, Math.min(90, Number(raw.cache?.ttlDays) || 7)),
      dir: String(raw.cache?.dir || 'state/cache').trim() || 'state/cache',
    },
    maxTokens: Math.max(256, Math.min(12000, Number(raw.maxTokens) || 2200)),
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.6,
    timeoutMs: Math.max(10000, Math.min(600000, Number(raw.timeoutMs) || 120000)),
    outDir: raw.outDir || 'runs',
    minSuccessfulProposals: Math.max(2, Math.min(participants.length, Number(raw.minSuccessfulProposals) || Number(raw.quorum?.min) || 3)),
    tally: {
      method: ['auto', 'condorcet', 'weighted'].includes(String(raw.tally?.method))
        ? String(raw.tally.method) : 'auto',
      selfScorePolicy: ['exclude', 'downweight', 'include'].includes(String(raw.tally?.selfScorePolicy))
        ? String(raw.tally.selfScorePolicy) : 'exclude',
      selfScoreWeight: Math.max(0, Math.min(1, Number(raw.tally?.selfScoreWeight) || 0)),
      stripSelfFromRanking: raw.tally?.stripSelfFromRanking !== false,
      voterTagBoost: Math.max(1, Math.min(2, Number(raw.tally?.voterTagBoost) || 1.25)),
    },
    decision: {
      maxVetoes: (() => {
        const value = Number(raw.decision?.maxVetoes)
        return Number.isFinite(value) && raw.decision?.maxVetoes !== '' && raw.decision?.maxVetoes != null
          ? Math.max(0, Math.min(5, value))
          : 1
      })(),
      budgetEscalationFactor: Math.max(1, Math.min(3, Number(raw.decision?.budgetEscalationFactor) || 1.6)),
      budgetEscalationCap: Math.max(1000, Math.min(100000, Number(raw.decision?.budgetEscalationCap) || 50000)),
    },
    buildGate: (() => {
      const commands = [
        ...normalizeList(raw.buildGate?.commands),
        raw.buildGate?.lint,
        raw.buildGate?.typecheck,
        raw.buildGate?.test,
      ].map((value) => String(value || '').trim()).filter(Boolean)
      return {
        required: raw.buildGate?.required !== undefined ? raw.buildGate.required !== false : commands.length > 0,
        runOnMeeting: raw.buildGate?.runOnMeeting !== false,
        timeoutMs: Math.max(1000, Math.min(1800000, Number(raw.buildGate?.timeoutMs) || 300000)),
        cwd: String(raw.buildGate?.cwd || '').trim(),
        commands,
        lint: String(raw.buildGate?.lint || ''),
        typecheck: String(raw.buildGate?.typecheck || ''),
        test: String(raw.buildGate?.test || ''),
      }
    })(),
  }
}

export function selectParticipants(config, options = {}) {
  const effectivePresetName = options.preset || config.selection.defaultPreset || ''
  const preset = effectivePresetName ? config.presets?.[effectivePresetName] : null
  const requireKeys = options.requireKeys !== false
  const explicit = normalizeList(options.agents).length
    ? normalizeList(options.agents)
    : normalizeList(preset?.agents)
  const exclude = new Set([...config.selection.exclude, ...normalizeList(options.exclude)])
  const requiredTags = normalizeList(options.requireTags).length
    ? normalizeList(options.requireTags)
    : (normalizeList(preset?.requireTags).length ? normalizeList(preset.requireTags) : config.selection.requireTags)
  const maxCostTier = Math.max(1, Math.min(5, Number(options.maxCostTier) || Number(preset?.maxCostTier) || config.selection.maxCostTier))
  const minCount = Math.max(2, Math.min(config.participants.length, Number(config.quorum.min) || 3))
  const wantedCount = Number(options.count) || Number(preset?.count) || config.selection.count
  const count = Math.max(minCount, Math.min(config.participants.length, wantedCount))

  if (explicit.length) {
    const selected = []
    const missing = []
    for (const value of explicit) {
      const participant = resolveParticipant(config.participants, value)
      if (!participant || !participant.enabled || (requireKeys && !participant.apiKey)) {
        missing.push(value)
        continue
      }
      if (!selected.some((p) => p.id === participant.id)) selected.push(participant)
    }
    if (missing.length) throw new Error('unknown or disabled agents: ' + missing.join(', '))
    if (selected.length < minCount) throw new Error(`explicit agent list must contain at least ${minCount} agents`)
    // An explicit roster is the user's choice, not a request to be sampled
    // down to config.selection.count. The count is a default for automatic
    // selection; truncating here made the UI show 7 and the meeting run 2.
    return selected
  }

  const pool = config.participants.filter((p) => {
    if (!p.enabled || (requireKeys && !p.apiKey) || exclude.has(p.id)) return false
    if (p.costTier > maxCostTier) return false
    if (requiredTags.length && !requiredTags.every((tag) => p.tags.includes(tag))) return false
    if (config.selection.include.length && !config.selection.include.includes(p.id)) return false
    return true
  })
  const selected = pool
    .sort((a, b) => b.qualityTier - a.qualityTier || a.costTier - b.costTier || a.id.localeCompare(b.id))
    .slice(0, count)
  if (selected.length < minCount) throw new Error(`selection produced ${selected.length} agents; need at least ${minCount}. Lower filters or add agents.`)
  return selected
}

export function publicRoster(config) {
  return config.participants.map((p) => ({
    id: p.id,
    label: p.label,
    provider: p.provider,
    model: p.model,
    baseUrl: p.baseUrl.replace(/\/+$/, ''),
    enabled: p.enabled,
    tags: p.tags,
    costTier: p.costTier,
    qualityTier: p.qualityTier,
    family: p.family,
    hasKey: p.hasKey === true || !!p.apiKey,
  }))
}

