import { callChat } from './providers.mjs'
import { resolveParticipant } from './model-aliases.mjs'

export async function compressHistory({ config, agentId, messages, targetChars = 1800 }) {
  const participant = resolveParticipant(config.participants || [], agentId)
    || resolveParticipant(config.participants || [], 'mimo-flash')
    || (config.participants || []).find((p) => p.enabled && p.apiKey)
  if (!participant) throw new Error('no agent available for context compression')
  const source = (Array.isArray(messages) ? messages : [])
    .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${String(message.content || '').slice(0, 5000)}`)
    .join('\n\n')
    .slice(0, 24000)
  const response = await callChat(
    { ...participant, reasoningEffort: 'low' },
    [
      { role: 'system', content: 'You compress conversation context. Return only the summary, no preamble.' },
      { role: 'user', content: `把以下对话压缩成可继续工作的上下文摘要，保留：目标、已确认决定、约束、未完成事项、关键路径/插件/结论。不要编造。控制在 ${targetChars} 字以内。\n\n${source}` },
    ],
    { ...config, maxTokens: 2200, timeoutMs: 120000 },
  )
  return {
    summary: String(response.content || '').trim().slice(0, targetChars * 2),
    usage: response.usage || null,
    agent: { id: participant.id, label: participant.label },
  }
}
