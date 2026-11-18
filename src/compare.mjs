import { loadConfig } from './config.mjs'
import { callChat } from './providers.mjs'
import { resolveParticipant } from './model-aliases.mjs'

function selectedParticipants(config, agentIds = []) {
  const requested = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(String).filter(Boolean))]
  const enabled = (config.participants || []).filter((participant) => participant.enabled !== false && participant.apiKey)
  if (requested.length) return requested.map((id) => resolveParticipant(enabled, id)).filter(Boolean)
  return enabled.slice(0, 3)
}

async function one(participant, prompt, settings) {
  const started = Date.now()
  try {
    const result = await callChat(participant, [
      { role: 'system', content: 'You are a focused software design assistant. Answer directly and concretely. Do not pretend to have run code you did not run.' },
      { role: 'user', content: prompt },
    ], settings)
    return {
      ok: true,
      agent: participant.id,
      label: participant.label || participant.id,
      model: participant.model,
      content: result.content,
      usage: result.usage || null,
      durationMs: result.durationMs || (Date.now() - started),
    }
  } catch (error) {
    return {
      ok: false,
      agent: participant.id,
      label: participant.label || participant.id,
      model: participant.model,
      error: String(error?.message || error),
      durationMs: Date.now() - started,
    }
  }
}

export async function mergeCompare({ configPath, prompt, results = [], mergeAgentId = '' }) {
  const config = loadConfig(configPath, { requireKeys: true })
  const usable = (Array.isArray(results) ? results : []).filter((result) => result?.ok && result.content)
  if (!usable.length) throw new Error('no successful answers to merge')
  const mergeAgent = resolveParticipant(config.participants || [], mergeAgentId || usable[0].agent)
  if (!mergeAgent || !mergeAgent.apiKey) throw new Error('merge agent not found or has no API key')
  const settings = { ...config, maxTokens: Math.max(64, Math.min(12000, Number(config.maxTokens) || 4000)) }
  const mergePrompt = [
    'You are merging several independent answers to the same request.',
    'Compare them, resolve disagreements, and return one concrete answer.',
    'Do not mention the model names. Preserve useful specifics; omit repetition.',
    '',
    'Original request:',
    String(prompt || ''),
    '',
    ...usable.map((result, index) => `--- Answer ${index + 1} (${result.label || result.agent || 'model'}) ---\n${result.content}`),
  ].join('\n')
  return one(mergeAgent, mergePrompt, settings)
}

export async function compareModels({ configPath, prompt, agentIds = [], mergeAgentId = '', merge = false, maxTokens, timeoutMs }) {
  const config = loadConfig(configPath, { requireKeys: true })
  const participants = selectedParticipants(config, agentIds)
  if (participants.length < 2) throw new Error('compare requires at least two enabled models with API keys')
  const settings = {
    ...config,
    maxTokens: Math.max(64, Math.min(12000, Number(maxTokens) || config.maxTokens)),
    timeoutMs: Math.max(10000, Math.min(900000, Number(timeoutMs) || config.timeoutMs)),
  }
  const results = await Promise.all(participants.map((participant) => one(participant, prompt, settings)))
  if (!merge) return { results, merge: null }
  const usable = results.filter((result) => result.ok)
  if (!usable.length) return { results, merge: null }
  const mergeAgent = resolveParticipant(config.participants || [], mergeAgentId || usable[0].agent)
  if (!mergeAgent || !mergeAgent.apiKey) throw new Error('merge agent not found or has no API key')
  const mergePrompt = [
    'You are merging several independent answers to the same request.',
    'Compare them, resolve disagreements, and return one concrete answer.',
    'Do not mention the model names. Preserve useful specifics; omit repetition.',
    '',
    'Original request:',
    prompt,
    '',
    ...usable.map((result, index) => `--- Answer ${index + 1} (${result.label}) ---\n${result.content}`),
  ].join('\n')
  const merged = await one(mergeAgent, mergePrompt, settings)
  return { results, merge: merged }
}
