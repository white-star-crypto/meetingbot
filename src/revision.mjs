import { callChat, extractJson } from './providers.mjs'
import { canonicalModelId, resolveParticipant } from './model-aliases.mjs'

function normalize(raw, issues = []) {
  const arr = (value, limit = 8) => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).filter(Boolean).slice(0, limit)
    : []
  const gaps = arr(raw.gaps).length ? arr(raw.gaps) : issues.map((issue) => issue.problem).filter(Boolean)
  const tasks = arr(raw.tasks || raw.repair_tasks, 10)
  const reassign = Array.isArray(raw.reassign)
    ? raw.reassign.map((item) => ({
      agent: String(item?.agent || item?.id || '').trim(),
      task: String(item?.task || item?.work || '').trim(),
    })).filter((item) => item.agent && item.task).slice(0, 10)
    : []
  return {
    verdict: String(raw.verdict || 'revise'),
    gaps,
    reassign,
    tasks,
    nextBrief: String(raw.nextBrief || raw.next_brief || raw.brief || '').trim(),
    rationale: String(raw.rationale || raw.summary || '').trim(),
    issues: issues.length ? issues : [],
  }
}

export async function runRevision({ config, brief, decision, review, agentId, issues, agents = [] }) {
  const requestedAgents = (Array.isArray(agents) ? agents : []).map(String).filter(Boolean)
  const allowedParticipants = requestedAgents.map((value) => resolveParticipant(config.participants || [], value)).filter(Boolean)
  const allowedIds = new Set(allowedParticipants.map((p) => p.id))
  const allowedCanonical = new Set(requestedAgents.map((value) => canonicalModelId(value)).filter(Boolean))
  const participants = (config.participants || [])
    .filter((p) => p.enabled && p.apiKey && (!allowedIds.size || allowedIds.has(p.id)))
  const foreman = resolveParticipant(participants, agentId)
    || resolveParticipant(participants, 'ds-flash')
    || participants[0]
  if (!foreman) throw new Error('no available agent for revision')
  const reviewIssues = Array.isArray(issues) && issues.length
    ? issues
    : (Array.isArray(review?.issues) ? review.issues : [])
  const agentList = participants.slice(0, 10).map((p) => `- ${p.id}: ${p.label}`).join('\n')
  const prompt = `你是这场会议的主 Bot。评审模型认为最终成品没有达到预期，需要回退到主 Bot 重新分发任务。

原始需求：
${String(brief || '').slice(0, 6000)}

当前决策：
${JSON.stringify(decision || {}, null, 2).slice(0, 8000)}

审图结论：
${JSON.stringify(review || {}, null, 2).slice(0, 5000)}

可用 Agent：
${agentList}

请只输出一个 JSON 对象，不要 Markdown：
{
  "verdict": "revise",
  "gaps": ["成品与预期的具体差距"],
  "reassign": [{"agent":"可用 Agent id","task":"重新分给它的具体修复/新增任务"}],
  "tasks": ["按顺序的修复任务"],
  "nextBrief": "下一轮会议的修正版需求，给全体 Agent 看",
  "rationale": "为什么这样重新分发"
}

要求：不要假装已经修改文件；只做重新评估和重新分发。任务必须具体到可验收，优先修 bug，再补新功能。`
  const response = await callChat(
    { ...foreman, reasoningEffort: 'high' },
    [
      { role: 'system', content: 'You are the elected foreman. Return only one JSON object. Do not claim work you did not do.' },
      { role: 'user', content: prompt },
    ],
    { ...config, maxTokens: 5000, timeoutMs: 300000 },
  )
  let raw
  try {
    raw = extractJson(response.content)
  } catch {
    raw = {
      gaps: reviewIssues.map((issue) => issue.problem).filter(Boolean),
      tasks: ['根据审图问题定位差异', '修复后重新验收'],
      reassign: [],
      nextBrief: String(brief || '').slice(0, 1200),
      rationale: '主 Bot 返回不是合法 JSON；已保留审图差距，等待人工补充任务。',
    }
  }
  const revision = normalize(raw, reviewIssues)
  if (allowedIds.size) revision.reassign = revision.reassign.filter((item) => allowedIds.has(item.agent) || allowedCanonical.has(canonicalModelId(item.agent)))
  return {
    ok: true,
    agent: { id: foreman.id, label: foreman.label, model: foreman.model },
    revision,
    usage: response.usage || null,
    durationMs: response.durationMs,
  }
}
