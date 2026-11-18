// Canonical model IDs are the UI/roster IDs. Older and example configs use
// provider ids (deepseek, glm, qwen...) or raw model ids (deepseek-chat).
// Everything that accepts a model id must go through this module.

export const CANONICAL_IDS = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']

const ALIASES = {
  deepseek: 'ds-flash',
  'deepseek-flash': 'ds-flash',
  'deepseek-chat': 'ds-flash',
  'deepseek-v4': 'ds-flash',
  'deepseek-v4-flash': 'ds-flash',
  'deepseek-v4-pro': 'ds-flash',
  'ds-flash': 'ds-flash',
  glm: 'glm-flash',
  'glm-flash': 'glm-flash',
  'glm-4.7-flash': 'glm-flash',
  'glm-5.3': 'glm-flash',
  'glm-5.3-flash': 'glm-flash',
  'glm-5-3': 'glm-flash',
  'glm-5-3-flash': 'glm-flash',
  mimo: 'mimo-flash',
  'mimo-flash': 'mimo-flash',
  'mimo-v2.6-flash': 'mimo-flash',
  'mimo-v2.6-pro': 'mimo-flash',
  qwen: 'qwen-flash',
  'qwen-flash': 'qwen-flash',
  'qwen-plus': 'qwen-flash',
  'qwen3.8': 'qwen-flash',
  'qwen3.8-flash': 'qwen-flash',
  'qwen3.8-max': 'qwen-flash',
  wenxin: 'wenxin-51',
  'wenxin-51': 'wenxin-51',
  'wenxin-5.1': 'wenxin-51',
  ernie: 'wenxin-51',
  'ernie-5.1': 'wenxin-51',
  doubao: 'doubao-turbo',
  'doubao-pro': 'doubao-turbo',
  'doubao-turbo': 'doubao-turbo',
  'doubao-1-5-pro': 'doubao-turbo',
  'doubao-1-5-thinking-pro': 'doubao-turbo',
  'doubao-seed-2-1-pro-260628': 'doubao-turbo',
  'doubao-seed-2-1-pro-260915': 'doubao-turbo',
  'doubao-seed-2-1-turbo-260628': 'doubao-turbo',
  minimax: 'minimax-flash',
  'minimax-flash': 'minimax-flash',
  'minimax-m3.1-flash': 'minimax-flash',
}

const VAULT_ENV = {
  'ds-flash': 'DEEPSEEK_API_KEY',
  'glm-flash': 'GLM_API_KEY',
  'mimo-flash': 'MIMO_API_KEY',
  'qwen-flash': 'DASHSCOPE_API_KEY',
  'wenxin-51': 'QIANFAN_API_KEY',
  'doubao-turbo': 'ARK_API_KEY',
  'minimax-flash': 'MINIMAX_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
}

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

export function canonicalModelId(value) {
  const key = normalize(value)
  if (!key) return ''
  return ALIASES[key] || (CANONICAL_IDS.includes(key) ? key : '')
}

export function vaultEnvFor(value) {
  const canonical = canonicalModelId(value)
  if (canonical && VAULT_ENV[canonical]) return VAULT_ENV[canonical]
  const key = normalize(value)
  return VAULT_ENV[key] || ''
}

export function resolveParticipant(participants, value) {
  const list = Array.isArray(participants) ? participants : []
  const wanted = normalize(value)
  if (!wanted) return null
  const exact = list.find((p) => normalize(p.id) === wanted)
  if (exact) return exact
  const canonical = canonicalModelId(value)
  if (canonical) {
    const byId = list.find((p) => canonicalModelId(p.id) === canonical)
    if (byId) return byId
    const byModel = list.find((p) => canonicalModelId(p.model) === canonical)
    if (byModel) return byModel
  }
  const byModelExact = list.find((p) => normalize(p.model) === wanted)
  if (byModelExact) return byModelExact
  const byLabelExact = list.find((p) => normalize(p.label) === wanted)
  if (byLabelExact) return byLabelExact
  const prefixMatches = list.filter((p) => {
    const label = normalize(p.label)
    return label.startsWith(wanted) || normalize(p.id).startsWith(wanted)
  })
  return prefixMatches.length === 1 ? prefixMatches[0] : null
}

export function resolveParticipantId(participants, value) {
  return resolveParticipant(participants, value)?.id || ''
}

export function canonicalizeAgentIds(participants, values) {
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    const participant = resolveParticipant(participants, value)
    if (participant && !out.includes(participant.id)) out.push(participant.id)
  }
  return out
}

export function canonicalParticipants(participants, allowedIds = CANONICAL_IDS) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds)
  const byCanonical = new Map()
  for (const participant of Array.isArray(participants) ? participants : []) {
    const canonical = canonicalModelId(participant?.id) || canonicalModelId(participant?.model)
    if (canonical && allowed.has(canonical) && !byCanonical.has(canonical)) {
      byCanonical.set(canonical, { ...participant, id: canonical })
    }
  }
  return [...byCanonical.values()]
}
