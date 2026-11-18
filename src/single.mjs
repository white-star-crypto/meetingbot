import path from 'node:path'
import { loadConfig } from './config.mjs'
import { callChat } from './providers.mjs'
import { resolveParticipant } from './model-aliases.mjs'

export async function askSingle({ configPath, agentId, prompt, system, maxTokens, timeoutMs, thinking }) {
  const config = loadConfig(configPath, { requireKeys: true })
  const participant = resolveParticipant(config.participants, agentId)
  if (!participant || !participant.enabled) throw new Error(`agent not found or disabled: ${agentId}`)
  if (!participant.apiKey) throw new Error(`agent has no API key: ${participant.id}`)
  const level = String(thinking || '').trim()
  if (level === 'none') {
    participant.noThink = true
    delete participant.reasoningEffort
  } else if (level && level !== 'default') {
    participant.noThink = false
    participant.reasoningEffort = level === 'on' ? 'high' : level === 'minimal' ? 'low' : level
  }
  const settings = {
    ...config,
    maxTokens: Math.max(64, Math.min(12000, Number(maxTokens) || config.maxTokens)),
    timeoutMs: Math.max(10000, Math.min(900000, Number(timeoutMs) || config.timeoutMs)),
  }
  const result = await callChat(participant, [
    { role: 'system', content: system || 'You are a focused software design assistant. Answer directly and concretely. Do not pretend to have run code you did not run.' },
    { role: 'user', content: prompt },
  ], settings)
  return {
    agent: participant.id,
    label: participant.label,
    model: participant.model,
    content: result.content,
    usage: result.usage || null,
    durationMs: result.durationMs,
  }
}
