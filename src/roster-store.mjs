import fs from 'node:fs'
import path from 'node:path'
import { canonicalModelId } from './model-aliases.mjs'

// The seven-model lineup is the canonical roster. Config still owns endpoints and
// keys; this store owns the user's choice, presets, pins and reasoning levels.
export const CANONICAL_IDS = [
  'ds-flash',
  'glm-flash',
  'mimo-flash',
  'qwen-flash',
  'wenxin-51',
  'doubao-turbo',
  'minimax-flash',
]

const ALIASES = {
  deepseek: 'ds-flash',
  'deepseek-flash': 'ds-flash',
  'ds-flash': 'ds-flash',
  'deepseek-v4-pro': 'ds-flash',
  glm: 'glm-flash',
  'glm-flash': 'glm-flash',
  'glm-5-3-flash': 'glm-flash',
  mimo: 'mimo-flash',
  'mimo-flash': 'mimo-flash',
  'mimo-v2.6-flash': 'mimo-flash',
  qwen: 'qwen-flash',
  'qwen-flash': 'qwen-flash',
  'qwen3.8-flash': 'qwen-flash',
  wenxin: 'wenxin-51',
  'wenxin-51': 'wenxin-51',
  'ernie-5.1': 'wenxin-51',
  doubao: 'doubao-turbo',
  'doubao-turbo': 'doubao-turbo',
  'doubao-pro': 'doubao-turbo',
  'doubao-seed-2-1-pro-260915': 'doubao-turbo',
  'doubao-seed-2-1-turbo-260628': 'doubao-turbo',
  minimax: 'minimax-flash',
  'minimax-flash': 'minimax-flash',
  'MiniMax-M3.1-Flash': 'minimax-flash',
}

const LEVELS = {
  'ds-flash': [
    { value: 'none', label: '关闭' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高' },
    { value: 'max', label: 'Max' },
  ],
  'glm-flash': [
    { value: 'none', label: '关闭' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
  ],
  'mimo-flash': [
    { value: 'none', label: '关闭' },
    { value: 'on', label: '开启' },
  ],
  'qwen-flash': [{ value: 'default', label: '标准' }],
  'wenxin-51': [{ value: 'default', label: '标准' }],
  'doubao-turbo': [
    { value: 'minimal', label: 'Min' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
  ],
  'minimax-flash': [{ value: 'default', label: '标准' }],
}

const DEFAULTS = {
  'ds-flash': { group: 'DeepSeek', defaultLevel: 'high' },
  'glm-flash': { group: 'GLM', defaultLevel: 'medium' },
  'mimo-flash': { group: 'MiMo', defaultLevel: 'on' },
  'qwen-flash': { group: 'Qwen', defaultLevel: 'default' },
  'wenxin-51': { group: 'Wenxin', defaultLevel: 'default' },
  'doubao-turbo': { group: 'Doubao', defaultLevel: 'medium' },
  'minimax-flash': { group: 'MiniMax', defaultLevel: 'default' },
}

const PRESET_THINKING = {
  one: 'low',
  two: 'high',
  three: 'high',
  'self-review': 'max',
  aesthetic: 'max',
}

function canonicalId(value) {
  const key = String(value || '').trim()
  if (key.startsWith('custom-')) return key
  return ALIASES[key] || (CANONICAL_IDS.includes(key) ? key : '')
}

function uniqueIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(canonicalId).filter(Boolean))]
}

function normalizeLevel(id, value) {
  const levels = LEVELS[id] || [{ value: 'default', label: '标准' }]
  const found = levels.find((level) => level.value === value)
  return found ? found.value : (DEFAULTS[id]?.defaultLevel || levels[0].value)
}

function buildModels(config) {
  const byId = new Map()
  for (const participant of config.participants) {
    const rawId = String(participant.id || '').trim()
    // A user-added endpoint is a distinct channel even when its model string
    // collides with a built-in alias (e.g. qwen3.8-flash -> qwen-flash).
    const id = rawId.startsWith('custom-')
      ? rawId
      : (canonicalId(rawId) || canonicalModelId(participant.model) || rawId)
    if (id) byId.set(id, participant)
  }
  const ids = [...CANONICAL_IDS.filter((id) => byId.has(id)), ...[...byId.keys()].filter((id) => !CANONICAL_IDS.includes(id))]
  const models = []
  for (const id of ids) {
    const participant = byId.get(id)
    if (!participant) continue
    const meta = DEFAULTS[id] || {}
    models.push({
      id,
      name: participant.label || id,
      model: participant.model,
      provider: participant.provider,
      baseUrl: participant.baseUrl || '',
      group: meta.group || participant.family || id,
      tags: participant.tags || [],
      levels: LEVELS[id] || [{ value: 'default', label: '标准' }],
      defaultLevel: meta.defaultLevel || 'default',
      enabled: participant.enabled !== false,
      hasKey: !!participant.apiKey,
    })
  }
  return models
}

function buildPresets(config, modelIds) {
  const out = {}
  const allowed = new Set(modelIds)
  for (const [id, preset] of Object.entries(config.presets || {})) {
    const agents = uniqueIds(preset.agents).filter((agentId) => allowed.has(agentId))
    if (new Set(agents).size < 2) continue
    const thinking = ['none', 'low', 'medium', 'high', 'max'].includes(String(preset.thinking))
      ? String(preset.thinking)
      : (PRESET_THINKING[id] || 'medium')
    out[id] = {
      label: String(preset.label || id),
      agents: [...new Set(agents)],
      thinking,
      builtin: true,
    }
  }
  if (!out.one && modelIds.length >= 2) {
    out.one = { label: 'DeepSeek + MiMo', agents: modelIds.slice(0, 2), thinking: 'low', builtin: true }
  }
  return out
}

function defaults(config) {
  const models = buildModels(config)
  const enabledIds = models.filter((model) => model.enabled).map((model) => model.id)
  const presets = buildPresets(config, enabledIds)
  const defaultPreset = config.selection?.defaultPreset && presets[config.selection.defaultPreset]
    ? config.selection.defaultPreset
    : (presets.one ? 'one' : Object.keys(presets)[0])
  const preset = presets[defaultPreset] || { agents: enabledIds.slice(0, 2), thinking: 'low' }
  const warnings = preset.agents.length < 2 ? ['可用模型不足：至少需要 2 个已启用模型；已降级为单模型阵容'] : []
  const thinking = {}
  for (const id of preset.agents) {
    thinking[id] = normalizeLevel(id, preset.thinking)
  }
  return {
    schema: 'heyi/roster/v1',
    name: '默认阵容',
    models,
    selected: [...preset.agents],
    thinking,
    presets,
    pinnedModels: preset.agents.slice(0, 2),
    pinnedPresets: defaultPreset ? [defaultPreset] : [],
    defaultPreset,
    workMode: 'council',
    degraded: warnings.length > 0,
    warnings,
    updatedAt: new Date().toISOString(),
  }
}

function mergeSaved(saved, base) {
  if (!saved || typeof saved !== 'object') return base
  const models = base.models
  const modelIds = new Set(models.map((model) => model.id))
  const selected = uniqueIds(saved.selected).filter((id) => modelIds.has(id))
  const chosen = selected.length >= 2 ? selected : base.selected
  const presets = {}
  const rawPresets = saved.presets && typeof saved.presets === 'object' ? saved.presets : {}
  for (const [id, preset] of Object.entries(rawPresets)) {
    const agents = uniqueIds(preset?.agents).filter((agentId) => modelIds.has(agentId))
    if (agents.length < 2) continue
    presets[id] = {
      label: String(preset.label || id).slice(0, 60),
      agents,
      thinking: ['none', 'low', 'medium', 'high', 'max'].includes(String(preset.thinking))
        ? String(preset.thinking)
        : 'medium',
      builtin: preset.builtin === true,
    }
  }
  for (const [id, preset] of Object.entries(base.presets)) {
    if (!presets[id]) presets[id] = preset
  }
  const thinking = {}
  for (const id of chosen) {
    thinking[id] = normalizeLevel(id, saved.thinking?.[id])
  }
  const defaultPreset = String(saved.defaultPreset || base.defaultPreset || '')
  const pinnedModels = uniqueIds(saved.pinnedModels).filter((id) => modelIds.has(id))
  const pinnedPresets = [...new Set((Array.isArray(saved.pinnedPresets) ? saved.pinnedPresets : [])
    .map(String).filter((id) => !!presets[id]))]
  return {
    ...base,
    name: String(saved.name || base.name).slice(0, 60),
    models,
    selected: chosen,
    thinking,
    presets,
    pinnedModels: Array.isArray(saved.pinnedModels) ? pinnedModels : base.pinnedModels,
    pinnedPresets: Array.isArray(saved.pinnedPresets) ? pinnedPresets : base.pinnedPresets,
    defaultPreset: presets[defaultPreset] ? defaultPreset : base.defaultPreset,
    workMode: ['council', 'division', 'ondemand'].includes(saved.workMode) ? saved.workMode : base.workMode,
    updatedAt: String(saved.updatedAt || base.updatedAt),
  }
}

export function createRosterStore({ config, statePath }) {
  const absolutePath = path.resolve(statePath)
  const base = defaults(config)

  const readRaw = () => {
    try {
      if (!fs.existsSync(absolutePath)) return null
      return JSON.parse(fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }

  let cache = mergeSaved(readRaw(), base)
  const persist = () => {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    const tmp = `${absolutePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, absolutePath)
  }
  if (!fs.existsSync(absolutePath)) persist()

  const publicState = () => ({
    ...cache,
    models: cache.models.map((model) => ({ ...model })),
    source: absolutePath,
  })

  const update = (patch = {}) => {
    const next = { ...cache }
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      next.name = String(patch.name || '').trim().slice(0, 60) || '默认阵容'
    }
    if (Array.isArray(patch.selected)) {
      const selected = uniqueIds(patch.selected).filter((id) => next.models.some((model) => model.id === id))
      if (selected.length >= 2) {
        next.selected = selected
        for (const id of selected) next.thinking[id] = normalizeLevel(id, next.thinking[id])
      }
    }
    if (patch.thinking && typeof patch.thinking === 'object') {
      const thinking = { ...next.thinking }
      for (const [id, value] of Object.entries(patch.thinking)) {
        if (next.selected.includes(id)) thinking[id] = normalizeLevel(id, value)
      }
      next.thinking = thinking
    }
    if (Array.isArray(patch.pinnedModels)) {
      next.pinnedModels = uniqueIds(patch.pinnedModels).filter((id) => next.models.some((model) => model.id === id))
    }
    if (Array.isArray(patch.pinnedPresets)) {
      next.pinnedPresets = [...new Set(patch.pinnedPresets.map(String).filter((id) => !!next.presets[id]))]
    }
    if (patch.presets && typeof patch.presets === 'object') {
      const presets = { ...next.presets }
      for (const [id, preset] of Object.entries(patch.presets)) {
        const agents = uniqueIds(preset?.agents).filter((agentId) => next.models.some((model) => model.id === agentId))
        if (agents.length < 2) continue
        presets[String(id).slice(0, 48)] = {
          label: String(preset.label || id).slice(0, 60),
          agents,
          thinking: ['none', 'low', 'medium', 'high', 'max'].includes(String(preset.thinking))
            ? String(preset.thinking)
            : 'medium',
          builtin: preset.builtin === true,
        }
      }
      next.presets = presets
    }
    if (patch.defaultPreset && next.presets[patch.defaultPreset]) next.defaultPreset = String(patch.defaultPreset)
    if (['council', 'division', 'ondemand'].includes(patch.workMode)) next.workMode = patch.workMode
    next.updatedAt = new Date().toISOString()
    cache = next
    persist()
    return publicState()
  }

  const refresh = (nextConfig) => {
    cache = mergeSaved(cache, defaults(nextConfig))
    return publicState()
  }

  const meetingSelection = (selection = {}) => {
    const preset = selection.preset && cache.presets[selection.preset] ? cache.presets[selection.preset] : null
    const hasKey = (id) => cache.models.some((model) => model.id === id && model.hasKey)
    const agents = uniqueIds(selection.agents).filter(hasKey)
    const presetAgents = (preset?.agents || []).filter(hasKey)
    const selected = agents.length >= 2 ? agents : (presetAgents.length >= 2 ? presetAgents : cache.selected.filter(hasKey))
    const thinking = {}
    for (const id of selected) {
      thinking[id] = normalizeLevel(id, selection.thinking?.[id] || cache.thinking[id] || preset?.thinking)
    }
    return {
      agents: [...new Set(selected)],
      thinking,
      workMode: ['council', 'division', 'ondemand'].includes(selection.workMode)
        ? selection.workMode
        : cache.workMode,
      preset: selection.preset || null,
    }
  }

  return { path: absolutePath, state: publicState, update, meetingSelection, refresh }
}
