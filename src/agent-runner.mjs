import { callChat, extractJson } from './providers.mjs'
import { executeAgentTool } from './tools.mjs'
import { resolveParticipant } from './model-aliases.mjs'
import { externalSkillsPrompt } from './external-skills.mjs'
import { createMcpManager } from './mcp-client.mjs'

const TOOL_DOC = `你可以使用这些工具：
- {"action":"ask_user","args":{"question":"需要用户确认的问题","options":["选项 A","选项 B"]}}  （向用户提问并暂停）
- {"action":"fs.list","args":{"path":"目录绝对路径"}}
- {"action":"fs.read","args":{"path":"文件绝对路径"}}
- {"action":"fs.write","args":{"path":"文件绝对路径","content":"完整内容"}}
- {"action":"fs.mkdir","args":{"path":"目录绝对路径"}}
- {"action":"python.run","args":{"code":"Python 源码","cwd":"工作目录绝对路径"}}
- {"action":"browser.open","args":{"url":"https://..."}}  （交给内置浏览器）
- {"action":"browser.read","args":{"url":"https://..."}}  （读取网页正文）
- {"action":"finish","answer":"给用户的最终回答"}

规则：
1. 每次只输出一个 JSON 对象，不要 Markdown，不要解释。
2. 先观察再行动；不确定路径时先 fs.list。
3. 不要假装执行过工具；只有工具返回的 observation 才算事实。
4. 任务完成必须调用 finish。
5. 是否调用 ask_user 由当前权限策略决定；不要为了“确认权限”而重复问。
6. 权限模式为当前设置；工具被拒绝时换方案或如实说明，不要绕过。`

function observationText(result) {
  const text = JSON.stringify(result)
  return text.length > 12000 ? text.slice(0, 12000) + '…（截断）' : text
}

function questionFrom(call, step) {
  const args = call.args && typeof call.args === 'object' ? call.args : {}
  const question = String(call.question || args.question || '').trim()
  const options = Array.isArray(call.options || args.options)
    ? (call.options || args.options).map(String).filter(Boolean).slice(0, 6)
    : []
  return { step, question: question || '需要你补充信息后才能继续。', options }
}

function toolFamily(action) {
  if (action.startsWith('browser.')) return 'browser'
  if (action.startsWith('fs.')) return 'files'
  if (action === 'python.run') return 'python'
  if (action === 'mcp.call') return 'mcp'
  return ''
}

async function loop({ participant, permissions, settings, messages, trace, usage, startStep, maxSteps, disabledTools = [], allowQuestions = true, mcp = null, scope = null, shouldAbort = null }) {
  const cancelled = (step) => ({
    ok: false,
    cancelled: true,
    error: '任务已取消',
    answer: '任务已取消。',
    trace,
    steps: step,
    usage,
    model: { id: participant.id, label: participant.label, model: participant.model },
  })
  for (let step = startStep; step <= maxSteps; step++) {
    if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelled(step)
    let response
    try {
      response = await callChat(participant, messages, settings)
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
        answer: '模型调用失败，未完成。',
        trace,
        steps: step,
        usage,
        model: { id: participant.id, label: participant.label, model: participant.model },
      }
    }
    if (response.usage) {
      usage.promptTokens += Number(response.usage.prompt_tokens) || 0
      usage.completionTokens += Number(response.usage.completion_tokens) || 0
    }
    messages.push({ role: 'assistant', content: response.content })
    let call
    try {
      call = extractJson(response.content)
    } catch {
      messages.push({ role: 'user', content: '不是合法 JSON。只返回一个工具调用对象，或 finish。' })
      trace.push({ step, action: 'parse-error', ok: false })
      if (step === maxSteps) break
      continue
    }
    const action = String(call.action || '')
    const args = call.args && typeof call.args === 'object' ? call.args : {}
    if (action === 'ask_user' && !allowQuestions) {
      trace.push({ step, action: 'ask_user', ok: false })
      messages.push({ role: 'user', content: '用户已关闭主动提问。不要调用 ask_user；依据现有信息选最稳妥的方案继续，信息不足就直接 finish 说明缺少什么。' })
      continue
    }
    if (action === 'ask_user') {
      const question = questionFrom(call, step)
      trace.push({ step, action, ok: true, question: question.question })
      return {
        ok: false,
        needsInput: true,
        question,
        trace,
        steps: step,
        usage,
        model: { id: participant.id, label: participant.label, model: participant.model },
        state: {
          participantId: participant.id,
          messages,
          trace,
          usage,
          step,
          scope,
        },
      }
    }
    if (action === 'finish') {
      const answer = String(call.answer || call.args?.answer || '').trim() || '任务完成。'
      trace.push({ step, action, ok: true })
      return {
        ok: true,
        answer,
        trace,
        steps: step,
        usage,
        model: { id: participant.id, label: participant.label, model: participant.model },
      }
    }
    let result
    if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelled(step)
    try {
      // Extra UI-level restriction. The backend permission gate still applies;
      // this can only make the Agent less capable, never more.
      const family = toolFamily(action)
      result = family && disabledTools.includes(family)
        ? { ok: false, error: `工具已在设置里关闭：${action}。换一种不依赖它的方式，或直接 finish 说明。` }
        : action === 'mcp.call'
          ? await mcp.call({ server: args.server, tool: args.tool, arguments: args.arguments || args.args || {} })
          : await executeAgentTool({ permissions, action, args, scope })
    } catch (error) {
      result = { ok: false, error: String(error?.message || error), code: error?.code || '' }
    }
    if (result?.needsConfirmation) {
      if (!allowQuestions) {
        messages.push({ role: 'user', content: `工具 ${action} 需要用户确认，但当前已关闭主动提问。不要覆盖/删除；直接 finish 说明需要用户批准。` })
        continue
      }
      const target = String(result.approval?.target || args.path || '')
      const question = {
        step,
        question: `Agent 请求${result.approval?.kind === 'delete' ? '删除' : '覆盖'}：${target}\n\n批准后才会执行，令牌只对这次操作有效。`,
        options: ['批准', '拒绝'],
      }
      trace.push({ step, action, ok: false, needsConfirmation: true, question: question.question })
      return {
        ok: false,
        needsInput: true,
        question,
        pendingApproval: result.approval,
        trace,
        steps: step,
        usage,
        model: { id: participant.id, label: participant.label, model: participant.model },
        state: { participantId: participant.id, messages, trace, usage, step, pendingApproval: result.approval, scope },
      }
    }
    const record = {
      step,
      action,
      args: Object.fromEntries(Object.entries(args).map(([key, value]) => [
        key,
        typeof value === 'string' && value.length > 600 ? value.slice(0, 600) + '…' : value,
      ])),
      ok: result.ok !== false,
      result: result.ok === false ? result : undefined,
    }
    if (action === 'browser.open' && result.url) record.result = { ok: true, url: result.url }
    if (action === 'fs.read' || action === 'fs.write' || action === 'fs.delete' || action === 'fs.list') {
      record.result = {
        ok: result.ok !== false,
        path: result.path || args.path || '',
        type: action === 'fs.list' ? 'dir' : 'file',
      }
      if (action === 'fs.write' || action === 'fs.delete') {
        record.result.diff = result.diff || ''
        record.result.diffSummary = result.diffSummary || ''
        record.result.diffTruncated = result.diffTruncated === true
        record.result.existed = result.existed === true
        record.result.checkpoint = result.checkpoint ? {
          id: result.checkpoint.id,
          action: result.checkpoint.action,
          existed: result.checkpoint.existed,
          createdAt: result.checkpoint.createdAt,
        } : null
        if (result.checkpointError) record.result.checkpointError = result.checkpointError
      }
    }
    trace.push(record)
    permissions.audit({ event: 'agent-tool', agent: participant.id, action, ok: record.ok })
    messages.push({
      role: 'user',
      content: `工具 ${action} 的 observation：\n${observationText(result)}\n\n继续。完成时只返回 finish JSON。`,
    })
  }
  return {
    ok: false,
    answer: `达到最大步数 ${maxSteps}，任务未完成。`,
    trace,
    steps: maxSteps,
    usage,
    model: { id: participant.id, label: participant.label, model: participant.model },
  }
}

function mcpToolDoc(tools) {
  const list = (Array.isArray(tools) ? tools : []).filter((tool) => tool.name)
  if (!list.length) return 'MCP 工具：未启用，或当前权限下没有可用的 readOnly server。'
  const lines = list.slice(0, 40).map((tool) => `- ${tool.server}/${tool.name}${tool.description ? `：${tool.description.slice(0, 200)}` : ''}`)
  return `MCP 工具（可选；先用 mcp.call 调用）：\n${lines.join('\n')}\n- 调用格式：{"action":"mcp.call","args":{"server":"SERVER_ID","tool":"TOOL_NAME","arguments":{}}}`
}

export async function runAgentTask({ config, agentId, task, permissions, maxSteps = 6, history = [], disabledTools = [], allowQuestions = true, scope = null, skills = [], shouldAbort = null }) {
  const participant = resolveParticipant(config.participants || [], agentId)
  if (!participant || !participant.enabled) throw new Error('agent not found or disabled: ' + agentId)
  if (!participant.apiKey) throw new Error('agent has no API key: ' + participant.id)
  const settings = { ...config, maxTokens: 3000, timeoutMs: 180000 }
  const allowed = permissions.current()
  const askPolicy = {
    'read-only': '你只能读。涉及写入、删除、安装、修改系统设置时先 ask_user，并说明只读模式会拒绝。',
    workspace: '工作区内可以自行执行。要写出工作区、动 C 盘/系统目录/注册表、安装或做不可逆操作时，先 ask_user。',
    'self-review': '你自行决定并执行，不要为了普通确认而问。只有遇到 C 盘/系统目录/注册表、不可逆操作、需要拍板的方向或关键信息缺失时才 ask_user。',
    full: '几乎不要 ask_user。用户给了任务就按任务直接执行，包括高风险操作；只有目标完全缺失、工具无法继续时才问。',
  }[allowed.id] || ''
  const historyMessages = (Array.isArray(history) ? history : [])
    .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
    .slice(-24)
    .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 8000) }))
  const mcp = createMcpManager({ config, permission: allowed.id, timeoutMs: config.mcp?.timeoutMs })
  let mcpTools = []
  try { if (mcp.enabled) mcpTools = await mcp.listTools() } catch { /* MCP is optional; do not block core agent */ }
  const skillDoc = externalSkillsPrompt(skills)
  const messages = [
    {
      role: 'system',
      content: `你是合议的本地执行 Agent。你有工具，但必须遵守当前权限模式。\n当前权限：${allowed.label}（${allowed.id}）\n工作区：${permissions.root}\n提问策略：${askPolicy}\n\n${TOOL_DOC}\n\n${mcpToolDoc(mcpTools)}${skillDoc ? '\n\n' + skillDoc : ''}`,
    },
    ...historyMessages,
    { role: 'user', content: `任务：${task}\n\n先返回一个工具调用 JSON；目标不清时先 ask_user；完成时返回 finish。` },
  ]
  try {
    return await loop({
      participant,
      permissions,
      settings,
      messages,
      trace: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      startStep: 1,
      maxSteps,
      disabledTools,
      allowQuestions,
      mcp,
      scope,
      shouldAbort,
    })
  } finally {
    await mcp.close()
  }
}

export async function resumeAgentTask({ config, state, answer, approved = false, permissions, maxSteps = 6, disabledTools = [], allowQuestions = true, scope = null, shouldAbort = null }) {
  const participant = resolveParticipant(config.participants || [], state.participantId)
  if (!participant || !participant.enabled) throw new Error('agent not found or disabled: ' + state.participantId)
  if (!participant.apiKey) throw new Error('agent has no API key: ' + participant.id)
  const settings = { ...config, maxTokens: 3000, timeoutMs: 180000 }
  const allowed = permissions.current()
  const mcp = createMcpManager({ config, permission: allowed.id, timeoutMs: config.mcp?.timeoutMs })
  try { if (mcp.enabled) await mcp.listTools() } catch { /* optional */ }
  const messages = [
    ...state.messages,
  ]
  if (state.pendingApproval) {
    const approval = state.pendingApproval
    const isApproved = approved === true
    if (isApproved) {
      const family = toolFamily(String(approval.action || ''))
      let result
      if (typeof shouldAbort === 'function' && shouldAbort() === true) {
        result = { ok: false, cancelled: true, error: '任务已取消，批准未执行', code: 'CANCELLED' }
      } else if (family && disabledTools.includes(family)) {
        result = { ok: false, error: `工具已停用：${family}；批准未执行`, code: 'TOOL_DISABLED' }
      } else {
        const args = { ...(approval.args || {}) }
        if (approval.kind === 'delete') {
          args.confirm = true
        } else {
          const token = permissions.issueConfirmation(approval.kind, approval.target)
          args.confirmToken = token.token
        }
        try { result = await executeAgentTool({ permissions, action: approval.action, args, approved: true, scope: state.scope || null }) }
        catch (error) { result = { ok: false, error: String(error?.message || error), code: error?.code || '' } }
      }
      permissions.audit({ event: 'agent-approval', agent: participant.id, action: approval.action, target: approval.target, approved: true, disabled: Boolean(family && disabledTools.includes(family)) })
      messages.push({ role: 'user', content: `用户已批准 ${approval.action}。执行结果：\n${observationText(result)}\n\n继续；完成时只返回 finish JSON。` })
    } else {
      permissions.audit({ event: 'agent-approval', agent: participant.id, action: approval.action, target: approval.target, approved: false })
      messages.push({ role: 'user', content: `用户拒绝了 ${approval.action}（${approval.target}）。不要再次尝试同一操作；换方案或直接 finish 说明。` })
    }
  }
  const reply = String(answer ?? '').trim()
  if (reply) messages.push({ role: 'user', content: `用户回答了上一轮问题：${reply}\n继续任务；需要时再调用工具，完成时返回 finish。` })
  try {
    return await loop({
      participant,
      permissions,
      settings,
      messages,
      trace: state.trace || [],
      usage: state.usage || { promptTokens: 0, completionTokens: 0 },
      startStep: (Number(state.step) || 1) + 1,
      maxSteps,
      disabledTools,
      allowQuestions,
      mcp,
      scope: state.scope || scope,
      shouldAbort,
    })
  } finally {
    await mcp.close()
  }
}
