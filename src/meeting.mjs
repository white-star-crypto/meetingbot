import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, publicRoster, selectParticipants } from './config.mjs'
import { callChat, extractJson } from './providers.mjs'
import { estimateTask } from './budget-planner.mjs'
import { planWorkMode } from './capability-router.mjs'
import { tally } from './tally.mjs'
import { validateDecisionDocument, isBuildGateSatisfied } from './decision-schema.mjs'
import { runBuildGate } from './build-gate.mjs'
import { createStageCache, stageCacheKey } from './cache.mjs'
import { resolveDataRoot } from './data-root.mjs'
import { extractBriefImages, withBriefImages } from './multimodal.mjs'

const VETO_CATEGORIES = new Set(['safety', 'scope', 'budget', 'infeasible', 'conflict'])
const MAX_BRIEF = 16000

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6)}`
}

function applyReasoning(participant, level) {
  const value = String(level || '').trim()
  if (!value) return
  if (value === 'none') {
    participant.noThink = true
    delete participant.reasoningEffort
    return
  }
  if (value === 'default') return
  participant.noThink = false
  if (value === 'on') participant.reasoningEffort = 'high'
  else if (value === 'minimal') participant.reasoningEffort = 'low'
  else if (['low', 'medium', 'high', 'max'].includes(value)) participant.reasoningEffort = value
}

function gateCommandList(config) {
  const direct = Array.isArray(config?.buildGate?.commands) ? config.buildGate.commands : []
  const named = [config?.buildGate?.lint, config?.buildGate?.typecheck, config?.buildGate?.test]
  return [...new Set([...named, ...direct].map((value) => String(value || '').trim()).filter(Boolean))]
}

function normalizeProposal(raw, id, participant) {
  if (!raw || typeof raw !== 'object') throw new Error(`proposal ${id} is not an object`)
  const str = (value, fallback = '') => String(value ?? fallback).trim()
  const risks = Array.isArray(raw.risks) ? raw.risks.map((s) => str(s)).filter(Boolean).slice(0, 8) : []
  const rawConfidence = raw?.confidence == null ? NaN : Number(raw.confidence)
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.5
  return {
    id,
    agentId: participant.id,
    agentLabel: participant.label,
    understanding: str(raw.understanding),
    architecture: str(raw.architecture),
    aesthetic: str(raw.aesthetic),
    risks,
    confidence,
    summary: str(raw.summary || raw.understanding).slice(0, 500),
  }
}

function mockProposals(participants, count = participants.length) {
  const seeds = [
    {
      understanding: '先做一个只读、可演示的生命状态舰桥，演示数据优先，接口后接。',
      architecture: '单页静态 HTML/CSS/JS，数据层独立成单一 JSON adapter；不引入框架和 CDN。',
      aesthetic: '冷蓝黑底、细网格、低饱和；信息密度高，标题有呼吸感，动效只做扫描线和脉冲。',
      risks: ['容易变成纯 UI 展示，功能价值不够', '数据契约如果不先定，后续适配会痛'],
      confidence: 0.78,
    },
    {
      understanding: '把需求拆成可验证的页面契约：先定快照字段，再让界面只消费投影。',
      architecture: '模块化静态站点 + 明确 data contract；页面与数据 adapter 解耦，支持替换 demo 数据。',
      aesthetic: '深色但不冷；大标题用宋体感，卡片用细边框和留白；把“她在哪”做成一个安静的坐标点。',
      risks: ['信息层级过多会稀释重点', '视觉方向需要真机截图验收'],
      confidence: 0.86,
    },
    {
      understanding: '做一个强交互的动态舰桥，用 canvas 表现脉搏和页面切换。',
      architecture: 'Canvas 渲染 + 事件驱动；视觉表现优先，数据用 mock stream。',
      aesthetic: '高对比霓虹、速度感、粒子流；适合短视频，但长时间阅读会累。',
      risks: ['可访问性和可读性风险高', '实现成本高，容易超过 MVP'],
      confidence: 0.62,
    },
    {
      understanding: '先做能被人一眼记住的封面和首屏，再补功能细节。',
      architecture: '极简静态页 + 局部组件；优先首屏和动效，功能页后置。',
      aesthetic: '黑白单色 + 超大字号 + 一条细红线；少即是多，让标题成为主角。',
      risks: ['可能牺牲功能完整性', '黑白方案与现有品牌色可能冲突'],
      confidence: 0.71,
    },
  ]
  const total = Math.max(1, Math.min(200, Number(count) || participants.length))
  return Array.from({ length: total }, (_, index) => normalizeProposal(seeds[index % seeds.length], `P${index + 1}`, participants[index % participants.length]))
}

function proposalMessages(brief, participant) {
  return [
    {
      role: 'system',
      content: 'You are one independent participant in a software design meeting. Return only one JSON object. Do not write code or markdown fences. Be concrete and opinionated. Your aesthetic view matters even if your engineering view is weak.',
    },
    {
      role: 'user',
      content: `Project brief:\n${brief.slice(0, MAX_BRIEF)}\n\nParticipant: ${participant.label}${participant.role ? `\nAssigned role in this meeting: ${participant.role}. Lead with that role; do not fake expertise outside it.` : ''}\n\nReturn JSON with exactly these fields:\n{\n  "understanding": "how you understand the requirement, 2-4 sentences",\n  "architecture": "concrete implementation approach, data flow, tradeoffs",\n  "aesthetic": "visual/interaction direction and why it fits",\n  "risks": ["risk 1", "risk 2"],\n  "confidence": 0.0,\n  "summary": "one-sentence proposal"\n}\nDo not mention other participants. Do not propose running code yet. Keep the whole JSON compact: each field at most 60 Chinese characters or 40 English words; do not restate the brief.`,
    },
  ]
}

function critiqueMessages(brief, proposals, interjectNote = '', role = '') {
  const anonymized = proposals.map((p) => ({
    id: p.id,
    understanding: p.understanding,
    architecture: p.architecture,
    aesthetic: p.aesthetic,
    risks: p.risks,
    confidence: p.confidence,
  }))
  return [
    {
      role: 'system',
      content: 'You are a reviewer in a cross-debate. Critique anonymized proposals on architecture, aesthetics, and security. Do not write code. Be concrete about what should survive and what should not. Return only one JSON object.',
    },
    {
      role: 'user',
      content: `Project brief:\n${brief.slice(0, MAX_BRIEF)}\n${role ? `\nYour assigned role: ${role}. Focus your critique on that role's concerns, but do not reveal or guess proposal authors.\n` : ''}\nAnonymized proposals:\n${JSON.stringify(anonymized, null, 2)}\n${interjectNote}\nReturn compact JSON:\n{\n  "critiques": {\n    "P1": {"architecture": "one concrete point", "aesthetics": "one concrete point", "security": "one concrete point", "keep": "what to keep"}\n  },\n  "best_aesthetic": "P1",\n  "summary": "max 200 characters: latest agreement and disagreement"\n}\nKeep every field under 160 characters.`,
    },
  ]
}

export function buildDebateDigest(critiqueRows, proposals, { anonymize = false } = {}) {
  const byProposal = new Map(proposals.map((p) => [p.id, []]))
  for (const row of critiqueRows) {
    for (const [id, critique] of Object.entries(row.critiques || {})) {
      if (!byProposal.has(id)) continue
      if (!critique || typeof critique !== 'object') continue
      const parts = [
        critique.architecture && `A:${critique.architecture}`,
        critique.aesthetics && `V:${critique.aesthetics}`,
        critique.security && `S:${critique.security}`,
        critique.keep && `K:${critique.keep}`,
      ].filter(Boolean).join(' | ').slice(0, 220)
      if (parts) byProposal.get(id).push(`${anonymize ? 'critic' : row.voter}: ${parts}`)
    }
  }
  return proposals.map((p) => {
    const notes = byProposal.get(p.id).join('；').slice(0, 700)
    return `${p.id}: ${notes || 'no critique'}`
  }).join('\n')
}

function voteMessages(brief, proposals, debateDigest = '', interjectNote = '') {
  const anonymized = proposals.map((p) => ({
    id: p.id,
    understanding: p.understanding,
    architecture: p.architecture,
    aesthetic: p.aesthetic,
    risks: p.risks,
    confidence: p.confidence,
  }))
  return [
    {
      role: 'system',
      content: 'You are a voter after a cross-debate. Proposals are anonymized. Judge architecture, aesthetics, and security separately. Do not favor a proposal because it sounds like yours. Your vote must carry a reason. Return only one JSON object.',
    },
    {
      role: 'user',
      content: `Project brief:\n${brief.slice(0, MAX_BRIEF)}\n\nAnonymized proposals:\n${JSON.stringify(anonymized, null, 2)}\n\nCross-debate digest (compressed):\n${debateDigest || 'none'}\n${interjectNote}\nReturn compact JSON:\n{\n  "vote_for": "P1",\n  "scores": {\n    "P1": {"architecture": 0, "aesthetics": 0, "security": 0},\n    "P2": {"architecture": 0, "aesthetics": 0, "security": 0}\n  },\n  "ranking": ["P1", "P2"],\n  "reason": "why this vote, including the best idea in the losing proposal"\n}\nScores are 0-10. Reason under 240 characters.`,
    },
  ]
}

function contentOrder(a, b) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b))
}

export function sanitizeVotesForForeman(votes) {
  const source = votes && typeof votes === 'object' ? votes : {}
  const rows = (Array.isArray(source.rows) ? source.rows : []).map((row) => {
    const { voter, voterTags, selfProposalId, fallback, replacedAgent, ...rest } = row || {}
    return rest
  }).sort(contentOrder)
  const audit = source.tallyAudit && typeof source.tallyAudit === 'object'
    ? {
      ...source.tallyAudit,
      ballots: (Array.isArray(source.tallyAudit.ballots) ? source.tallyAudit.ballots : []).map((ballot) => {
        const { voter, voterTags, selfProposalId, fallback, replacedAgent, ...rest } = ballot || {}
        return rest
      }).sort(contentOrder),
      selfEvaluations: [],
      selfTransfers: [],
      selfAbstentions: [],
    }
    : source.tallyAudit
  const { debateDigest, foremanDebateDigest, foreman, electedForeman, actingForeman, missing, ...rest } = source
  return { ...rest, rows, tallyAudit: audit }
}

export function decisionMessages(brief, proposals, votes, electedProposalId, debateDigest = '', interjectNote = '', options = {}) {
  const anonymized = proposals.map((p) => ({
    id: p.id,
    understanding: p.understanding,
    architecture: p.architecture,
    aesthetic: p.aesthetic,
    risks: p.risks,
    confidence: p.confidence,
  }))
  const actingForeman = options.actingForeman || null
  const ownerSelectedForeman = options.ownerSelectedForeman === true
  const freezeVeto = options.freezeVeto === true
  const requestedVetoes = Number(options.maxVetoes)
  const maxVetoes = Math.max(0, Math.min(5, Number.isFinite(requestedVetoes) ? requestedVetoes : 1))
  const voteSummary = sanitizeVotesForForeman(votes)
  const vetoExample = (actingForeman || maxVetoes === 0)
    ? '"veto": []'
    : '"veto": [{"proposal": "P2", "category": "scope", "reason": "concrete boundary or failure"}]'
  const roleLine = actingForeman
    ? `You are the acting foreman because the ${ownerSelectedForeman ? 'owner-appointed' : 'elected'} foreman failed to produce a valid decision. The owner's ${ownerSelectedForeman ? 'appointment' : 'election'} still stands for ${electedProposalId}. Veto power is frozen: do not veto anything; preserve the elected proposal and only help with merge/repair tasks.`
    : (ownerSelectedForeman
      ? `You are the foreman appointed by the owner. The anonymized vote winner is ${electedProposalId}; the vote still ranks proposals, but the owner chose you to make the final decision. You may issue at most ${maxVetoes} veto${maxVetoes === 1 ? '' : 'es'}, and a veto is only valid for safety, scope, budget, infeasibility, or a hard conflict. Aesthetic disagreement is NOT a veto; preserve the best ideas through merge_plan.`
      : (maxVetoes === 0
        ? 'You are the elected foreman. You may not issue a veto in this run; preserve the best ideas through merge_plan. Return only one JSON object.'
        : `You are the elected foreman. You may issue at most ${maxVetoes} veto${maxVetoes === 1 ? '' : 'es'}, and a veto is only valid for safety, scope, budget, infeasibility, or a hard conflict. Aesthetic disagreement is NOT a veto; preserve the best ideas through merge_plan.`))
  return [
    {
      role: 'system',
      content: `${roleLine} The vote summary shown to you has voter identities and self-proposal mappings removed; do not try to reconstruct them. Return only one JSON object.`,
    },
    {
      role: 'user',
      content: `Project brief:\n${brief.slice(0, MAX_BRIEF)}\n\nAnonymized proposals:\n${JSON.stringify(anonymized, null, 2)}\n\nCross-debate digest (compressed):\n${debateDigest || 'none'}\n\nWeighted vote summary (authors hidden):\n${JSON.stringify(voteSummary, null, 2)}\n\nElected proposal: ${electedProposalId}\n${actingForeman ? `Acting foreman note: this is an emergency completion; the elected proposal is still ${electedProposalId}. Do not adopt a different proposal as the winner and do not veto.\n` : ''}${interjectNote}\nReturn compact JSON. Veto entries MUST be objects, never strings. Allowed veto categories: safety, scope, budget, infeasible, conflict.\n{\n  "adopt": ["${electedProposalId}"],\n  ${vetoExample},\n  "rejected_strengths": [{"proposal": "P2", "strength": "what should be preserved"}],\n  "merge_plan": "how to combine adopted proposals and minority aesthetic ideas",\n  "risks": ["risk of the adopted direction"],\n  "build_tasks": ["step 1", "step 2"],\n  "code_structure": {"modules": ["module: responsibility"], "flow": ["data flow step"]},\n  "rationale": "short decision rationale"\n}\nThe final decision must adopt the elected proposal ${electedProposalId}. Do not write code.`,
    },
  ]
}

export function validateDecision(raw, proposals, winnerId, { freezeVeto = false, freezeAdopt = false, maxVetoes = 1 } = {}) {
  const warnings = []
  const ids = new Set(proposals.map((p) => p.id))
  let adopt = Array.isArray(raw?.adopt) ? raw.adopt.map(String).filter((id) => ids.has(id)) : []
  // Inject the elected proposal BEFORE validating vetoes. Otherwise a veto on
  // the winner looks valid during the loop and only later becomes a
  // contradiction once the winner is added to adopt.
  if (!adopt.includes(winnerId)) {
    adopt.unshift(winnerId)
    warnings.push(`adopt list omitted elected proposal ${winnerId}; added it to keep adopt/winner consistent`)
  }
  adopt = [...new Set(adopt)]
  const veto = Array.isArray(raw?.veto) ? raw.veto : []
  let normalizedVeto = []
  for (const item of veto) {
    const proposal = String(item?.proposal || '')
    const category = String(item?.category || '')
    const reason = String(item?.reason || '').trim()
    if (!ids.has(proposal)) { warnings.push(`unknown veto target ${proposal}; ignored`); continue }
    if (!VETO_CATEGORIES.has(category)) {
      warnings.push(`${proposal}: veto category "${category}" is not allowed; aesthetic/other disagreement is merge, not veto`)
      continue
    }
    if (!reason) { warnings.push(`${proposal}: empty veto reason; ignored`); continue }
    if (adopt.includes(proposal)) { warnings.push(`${proposal}: both adopted and vetoed; adopt wins`); continue }
    normalizedVeto.push({ proposal, category, reason })
  }
  if (freezeVeto && normalizedVeto.length) {
    warnings.push(`failover foreman veto power is frozen; dropped ${normalizedVeto.length} veto(es)`)
    normalizedVeto = []
  }
  const limit = Math.max(0, Math.min(5, Number(maxVetoes) || 0))
  if (normalizedVeto.length > limit) {
    warnings.push(`veto limit is ${limit}; dropped ${normalizedVeto.length - limit} extra veto(es)`)
    normalizedVeto = normalizedVeto.slice(0, limit)
  }
  adopt = [...new Set(adopt)]
  if (freezeAdopt) {
    const extra = adopt.filter((id) => id !== winnerId)
    if (extra.length) warnings.push(`failover foreman adopt power is limited to elected proposal ${winnerId}; dropped ${extra.join(', ')}`)
    adopt = [winnerId]
  }
  if (!adopt.length) {
    adopt = [winnerId]
    warnings.push(`empty adopt list; fallback to elected proposal ${winnerId}`)
  }
  const fallback = !Array.isArray(raw?.adopt) || !Array.isArray(raw?.veto)
  return {
    adopt,
    veto: normalizedVeto,
    rejected_strengths: Array.isArray(raw?.rejected_strengths)
      ? raw.rejected_strengths.map((x) => ({ proposal: String(x?.proposal || ''), strength: String(x?.strength || '') })).filter((x) => ids.has(x.proposal) && x.strength).slice(0, 12)
      : [],
    merge_plan: String(raw?.merge_plan || '').trim(),
    risks: Array.isArray(raw?.risks) ? raw.risks.map(String).filter(Boolean).slice(0, 12) : [],
    build_tasks: Array.isArray(raw?.build_tasks) ? raw.build_tasks.map(String).filter(Boolean).slice(0, 20) : [],
    code_structure: raw?.code_structure && typeof raw.code_structure === 'object' ? {
      modules: Array.isArray(raw.code_structure.modules) ? raw.code_structure.modules.map(String).filter(Boolean).slice(0, 12) : [],
      flow: Array.isArray(raw.code_structure.flow) ? raw.code_structure.flow.map(String).filter(Boolean).slice(0, 12) : [],
    } : { modules: [], flow: [] },
    rationale: String(raw?.rationale || '').trim(),
    warnings,
    fallback,
  }
}

function fallbackDecision(proposals, winnerId, reason) {
  return {
    adopt: [winnerId],
    veto: [],
    rejected_strengths: [],
    merge_plan: 'Owner review required: the foreman response could not be validated.',
    risks: ['Foreman decision could not be validated; owner must review.'],
    build_tasks: [],
    code_structure: { modules: [], flow: [] },
    rationale: reason,
    warnings: ['fallback decision used'],
    fallback: true,
  }
}

export async function runMeeting({ briefPath, configPath, outDir, mock = false, mockDelayMs = 0, mockSize = 0, parentRunId = '', cache = true, cacheDir = '', selection = {}, resumeDir = '', executionIntent = 'decide', permissionMode = '', onPhase, onProgress, onParticipant, getInterjections, shouldAbort }) {
  if (!configPath) throw new Error('configPath is required (mock meetings still need a roster config)')
  const brief = (await fs.readFile(path.resolve(briefPath), 'utf8')).trim()
  if (!brief) throw new Error('brief is empty')
  const briefImages = await extractBriefImages(brief, path.dirname(path.resolve(briefPath)))
  const briefImageWarnings = briefImages.warnings
  const delayMs = Math.max(0, Math.min(5000, Number(mockDelayMs) || 0))
  const pause = async () => { if (mock && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs)) }
  const abortIfRequested = () => {
    if (typeof shouldAbort !== 'function' || !shouldAbort()) return
    const cancelled = new Error('meeting cancelled by owner')
    cancelled.code = 'MEETING_CANCELLED'
    throw cancelled
  }
  const config = loadConfig(configPath, { requireKeys: !mock })
  const effectivePresetName = selection.preset || config.selection.defaultPreset || ''
  let participants = selectParticipants(config, { ...selection, preset: effectivePresetName, requireKeys: !mock })
  const workPlan = planWorkMode({
    task: brief,
    mode: selection.workMode || 'council',
    participants,
  })
  participants = workPlan.participants
  const selectedParticipants = [...participants]
  const requestedForemanId = String(selection.foremanId || '').trim()
  const requestedForeman = requestedForemanId ? participants.find((p) => p.id === requestedForemanId) : null
  if (requestedForemanId && !requestedForeman) {
    const invalid = new Error('指定的主 Bot 不在本场参与模型内')
    invalid.code = 'FOREMAN_NOT_SELECTED'
    throw invalid
  }
  const foremanSelection = requestedForeman ? 'owner' : 'auto'
  for (const participant of participants) {
    if (workPlan.roles[participant.id]) participant.role = workPlan.roles[participant.id]
  }
  let budget = estimateTask(brief, { sourceChars: brief.length, modelCount: participants.length })
  let planSettings = { ...config, maxTokens: budget.planTokens }
  let decisionSettings = { ...config, maxTokens: budget.mainTokens }
  const stageCache = createStageCache({
    dir: cacheDir || path.resolve(resolveDataRoot(), config.cache?.dir || 'state/cache'),
    enabled: cache !== false && config.cache?.enabled !== false && !mock,
    ttlMs: (Number(config.cache?.ttlDays) || 7) * 24 * 60 * 60 * 1000,
  })
  const callBudgeted = async (participant, messages, settings, phase) => {
    let attemptSettings = settings
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cacheKey = stageCacheKey({ phase, participant, messages, settings: attemptSettings })
        const cached = await stageCache.get(cacheKey)
        if (cached) {
          await log({ phase: 'cache-hit', stage: phase, agent: participant.id })
          return cached
        }
        const response = await callChat(participant, messages, attemptSettings)
        if (['length', 'max_tokens'].includes(String(response.finishReason || '').toLowerCase())) throw new Error(`${participant.id}: output length (${response.finishReason})`)
        await stageCache.set(cacheKey, response)
        return response
      } catch (error) {
        lastError = error
        const message = String(error?.message || error)
        const canEscalate = /empty content|length|timed out|timeout|aborted/i.test(message)
        if (!canEscalate || attempt === 1) {
          // Keep the failing model and phase on the error so the panel can tell
          // the user exactly which model and which step failed.
          if (error && typeof error === 'object') {
            error.stage = phase
            error.agentId = participant.id
            error.agentLabel = participant.label
          }
          throw error
        }
        attemptSettings = {
          ...settings,
          maxTokens: Math.min(
            config.decision?.budgetEscalationCap ?? 50000,
            Math.round(settings.maxTokens * (config.decision?.budgetEscalationFactor ?? 1.6)),
          ),
        }
        await log({ phase: 'budget-escalation', agent: participant.id, stage: phase, from: settings.maxTokens, to: attemptSettings.maxTokens })
      }
    }
    throw lastError
  }
  const preset = effectivePresetName ? config.presets?.[effectivePresetName] : null
  const explicitThinking = selection.thinking && typeof selection.thinking === 'object' ? selection.thinking : {}
  for (const participant of participants) {
    const level = explicitThinking[participant.id] || preset?.thinking || ''
    if (level) applyReasoning(participant, level)
  }
  const resumePath = resumeDir ? path.resolve(resumeDir) : ''
  const runId = resumePath ? path.basename(resumePath) : stamp()
  const runDir = resumePath || path.resolve(outDir || config.outDir, runId)
  await fs.mkdir(path.join(runDir, 'proposals'), { recursive: true })
  const reuse = { proposals: [], critiques: null, votes: null, decision: null }
  let partialResume = false
  if (resumePath) {
    try {
      const names = (await fs.readdir(path.join(runDir, 'proposals'))).filter((name) => /^P\d+\.json$/.test(name)).sort()
      for (const name of names) reuse.proposals.push(JSON.parse(await fs.readFile(path.join(runDir, 'proposals', name), 'utf8')))
    } catch { /* partial run may have no proposals */ }
    const expectedSlots = participants.map((_, index) => `P${index + 1}`)
    const loadedIds = new Set(reuse.proposals.map((proposal) => String(proposal?.id || '')))
    if (reuse.proposals.length && (reuse.proposals.length !== participants.length || !expectedSlots.every((id) => loadedIds.has(id)))) {
      // Never silently shrink the committee after a partial resume. Regenerate
      // the proposal phase rather than reusing only the slots that survived.
      reuse.proposals = []
      partialResume = true
    }
    try { reuse.critiques = JSON.parse(await fs.readFile(path.join(runDir, 'critiques.json'), 'utf8')) } catch {}
    try { reuse.votes = JSON.parse(await fs.readFile(path.join(runDir, 'votes.json'), 'utf8')) } catch {}
    try { reuse.decision = JSON.parse(await fs.readFile(path.join(runDir, 'decision.json'), 'utf8')) } catch {}
  }
  const transcriptPath = path.join(runDir, 'transcript.jsonl')
  // Model calls run in parallel. On Windows two simultaneous append handles on
  // the same file fail with EPERM, which used to be misreported as a model
  // failure and could break quorum. Serialise transcript writes so a meeting
  // never loses a proposal to a log-file race.
  let transcriptQueue = Promise.resolve()
  const log = async (event) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
    transcriptQueue = transcriptQueue.catch(() => {}).then(() => fs.appendFile(transcriptPath, line, 'utf8'))
    return transcriptQueue
  }
  let previousMeta = {}
  if (resumePath) { try { previousMeta = JSON.parse(await fs.readFile(path.join(runDir, 'meta.json'), 'utf8')) } catch {} }
  const usage = { promptTokens: Number(previousMeta.usage?.promptTokens) || 0, completionTokens: Number(previousMeta.usage?.completionTokens) || 0 }
  const errors = Array.isArray(previousMeta.errors) ? previousMeta.errors.map((row) => ({ ...row })) : []
  // Mid-meeting owner interjections. Proposals already left with the original
  // brief; interjections are read fresh each time a phase builds its prompts,
  // so they enter every phase whose prompts are built after they arrive (a
  // phase already in flight cannot be changed retroactively — the UI copy says
  // "接下来的阶段", not "all three phases"). The transcript event is written
  // lazily on first real injection so the audit trail matches the prompts.
  let interjectEventLogged = false
  const readInterjections = () => {
    try {
      const list = typeof getInterjections === 'function' ? getInterjections() : []
      return (Array.isArray(list) ? list : [])
        .map((item) => String(item?.text || '').trim())
        .filter(Boolean)
        .slice(-12)
    } catch { return [] }
  }
  const interjectNote = () => {
    const notes = readInterjections()
    if (!notes.length) return ''
    if (!interjectEventLogged) {
      interjectEventLogged = true
      log({ phase: 'interjections', count: notes.length, notes: notes.map((n) => n.slice(0, 500)) }).catch(() => {})
    }
    return `\n\nOwner interjections during this meeting (authoritative constraints, weigh them in your output):\n${notes.map((n, i) => `${i + 1}. ${n.slice(0, 1000)}`).join('\n')}`
  }
  const interjectionsSoFar = () => readInterjections().map((text) => ({ text }))
  await fs.writeFile(path.join(runDir, 'brief.md'), brief + '\n', 'utf8')
  if (briefImages.images.length || briefImageWarnings.length) await log({ phase: 'brief-images', count: briefImages.images.length, paths: briefImages.images.map((image) => path.relative(runDir, image.path)), warnings: briefImageWarnings })
  await fs.writeFile(path.join(runDir, 'roster.json'), JSON.stringify(publicRoster(config), null, 2) + '\n', 'utf8')
  // Early meta so an interrupted run is resumable: /resume locates runs by
  // meta.json, and without this write a crash before the final meta left the
  // checkpoint branch unreachable. The final write below replaces this file.
  if (!resumePath) {
    await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
      schema: 'meetingbot/run/v1',
      runId,
      createdAt: new Date().toISOString(),
      mode: mock ? 'mock' : 'live',
      status: 'running',
      executionIntent: executionIntent === 'execute' ? 'execute' : 'decide',
      permissionMode: String(permissionMode || '') || undefined,
      parentRunId: String(parentRunId || '') || null,
      brief: path.resolve(briefPath),
      config: path.resolve(configPath),
      roster: publicRoster(config),
      selected: publicRoster({ participants: selectedParticipants }),
      selection,
      workMode: workPlan.mode,
    }, null, 2) + '\n', 'utf8')
  }

  if (partialResume) await log({ phase: 'resume-partial-proposals', action: 'regenerate', expected: participants.length })
  let proposals = reuse.proposals.length ? reuse.proposals : null
  const fallbackInfo = new Map()
  // Per-call progress for the panel's live card. Failures also count as
  // "done": the step is over, and the phase's error handling decides what it
  // means. onProgress is optional so existing callers keep working.
  let proposalDone = 0
  let proposalTotal = participants.length
  const reportProposalProgress = () => { try { onProgress?.({ phase: '独立提案', done: proposalDone, total: proposalTotal }) } catch {} }
  // Participant-level status is a separate, optional channel: the panel shows
  // "who is running / who finished / who failed" without changing the phase
  // progress contract. Every call reports running then done|failed — a failed
  // call is still reported so the card names the model instead of guessing.
  const reportParticipant = (participant, phase, status, usage) => {
    try {
      const prompt = Number(usage?.prompt_tokens ?? usage?.promptTokens) || 0
      const completion = Number(usage?.completion_tokens ?? usage?.completionTokens) || 0
      onParticipant?.({
        agentId: String(participant?.id || ''),
        agentLabel: String(participant?.label || participant?.labelName || participant?.id || ''),
        phase,
        status,
        tokens: prompt + completion,
      })
    } catch {}
  }
  onPhase?.('独立提案')
  if (!proposals) {
if (mock) {
    proposals = mockProposals(participants, mockSize)
    proposalTotal = proposals.length
    for (const proposal of proposals) {
      const person = participants.find((p) => p.id === proposal.agentId) || { id: proposal.agentId, label: proposal.agentLabel || proposal.agentId }
      reportParticipant(person, '独立提案', 'running')
      await pause()
      await fs.writeFile(path.join(runDir, 'proposals', `${proposal.id}.json`), JSON.stringify(proposal, null, 2) + '\n', 'utf8')
      await log({ phase: 'proposal', agent: proposal.agentId, proposal: proposal.id, mock: true })
      reportParticipant(person, '独立提案', 'done')
    }
    proposalDone = proposals.length
    reportProposalProgress()
  } else {
    const results = await Promise.all(participants.map(async (participant, index) => {
      const id = `P${index + 1}`
      try {
        reportParticipant(participant, '独立提案', 'running')
        const response = await callBudgeted(participant, withBriefImages(proposalMessages(brief, participant), briefImages.images, participant), planSettings, 'proposal')
        const raw = extractJson(response.content)
        const proposal = normalizeProposal(raw, id, participant)
        if (response.usage) {
          usage.promptTokens += Number(response.usage.prompt_tokens) || 0
          usage.completionTokens += Number(response.usage.completion_tokens) || 0
        }
        await fs.writeFile(path.join(runDir, 'proposals', `${id}.json`), JSON.stringify(proposal, null, 2) + '\n', 'utf8')
        await log({ phase: 'proposal', agent: participant.id, proposal: id, durationMs: response.durationMs, usage: response.usage || null })
        proposalDone++
        reportProposalProgress()
        reportParticipant(participant, '独立提案', 'done', response.usage)
        return proposal
      } catch (error) {
        const message = String(error?.message || error)
        errors.push({ phase: 'proposal', agent: participant.id, proposal: id, error: message })
        await log({ phase: 'proposal-error', agent: participant.id, proposal: id, error: message })
        proposalDone++
        reportProposalProgress()
        reportParticipant(participant, '独立提案', 'failed')
        return null
      }
    }))

    // Fallback: if a selected model fails, try a configured backup for the same slot.
    // This does not change the participant count; it preserves quorum.
    const usedAgentIds = new Set(participants.map((p) => p.id))
    for (let i = 0; i < results.length; i++) {
      if (results[i]) continue
      const id = `P${i + 1}`
      const replacedAgent = participants[i]?.id || ''
      for (const fallbackId of config.selection.fallbacks) {
        if (usedAgentIds.has(fallbackId)) continue
        const fallback = config.participants.find((p) => p.id === fallbackId && p.enabled)
        if (!fallback) continue
        usedAgentIds.add(fallbackId)
        try {
          if (workPlan.roles[fallback.id]) fallback.role = workPlan.roles[fallback.id]
          const fallbackThinking = explicitThinking[fallback.id] || preset?.thinking || ''
          if (fallbackThinking) applyReasoning(fallback, fallbackThinking)
          const response = await callBudgeted(fallback, withBriefImages(proposalMessages(brief, fallback), briefImages.images, fallback), planSettings, 'proposal-fallback')
          const raw = extractJson(response.content)
          const proposal = normalizeProposal(raw, id, fallback)
          if (response.usage) {
            usage.promptTokens += Number(response.usage.prompt_tokens) || 0
            usage.completionTokens += Number(response.usage.completion_tokens) || 0
          }
          await fs.writeFile(path.join(runDir, 'proposals', `${id}.json`), JSON.stringify(proposal, null, 2) + '\n', 'utf8')
          await log({ phase: 'proposal-fallback', agent: fallback.id, replaced: participants[i].id, proposal: id, durationMs: response.durationMs, usage: response.usage || null })
          if (!participants.some((p) => p.id === fallback.id)) participants.push(fallback)
          fallbackInfo.set(id, { fallback: true, replacedAgent })
          results[i] = proposal
          break
        } catch (error) {
          const message = String(error?.message || error)
          errors.push({ phase: 'proposal-fallback', agent: fallback.id, proposal: id, error: message })
          await log({ phase: 'proposal-fallback-error', agent: fallback.id, proposal: id, error: message })
        }
      }
    }
    proposals = results.filter(Boolean)
  }

  }

  if (participants.length !== selectedParticipants.length) {
    budget = estimateTask(brief, { sourceChars: brief.length, modelCount: participants.length })
    planSettings = { ...config, maxTokens: budget.planTokens }
    decisionSettings = { ...config, maxTokens: budget.mainTokens }
  }
  if (proposals.length < Math.min(config.minSuccessfulProposals, selectedParticipants.length)) {
    await fs.writeFile(path.join(runDir, 'errors.json'), JSON.stringify(errors, null, 2) + '\n', 'utf8')
    const failure = new Error(`only ${proposals.length} proposals succeeded; need ${Math.min(config.minSuccessfulProposals, selectedParticipants.length)}`)
    failure.stage = 'proposal'
    failure.agentId = errors.filter((e) => e.phase === 'proposal').map((e) => e.agent).join(', ')
    throw failure
  }
  const index = proposals.map((p) => ({ proposal: p.id, agent: p.agentId, label: p.agentLabel, summary: p.summary }))
  await fs.writeFile(path.join(runDir, 'proposals', '_index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

  abortIfRequested()
  let critiqueRows = []
  let critiqueDone = 0
  const reportCritiqueProgress = () => { try { onProgress?.({ phase: '交叉批判', done: critiqueDone, total: participants.length }) } catch {} }
  onPhase?.('交叉批判')
  if (!reuse.critiques) {
if (mock) {
    critiqueRows = []
    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i]
      reportParticipant(participant, '交叉批判', 'running')
      await pause()
      critiqueRows.push({
        voter: participant.id,
        critiques: Object.fromEntries(proposals.map((p, j) => [p.id, {
          architecture: j === 0 ? '数据契约清晰，但页面边界还可以更硬' : '结构可行，但复杂度需要压住',
          aesthetics: j === 3 ? '黑白大字很有记忆点，但功能页会显得空' : '暖中性更耐看，但重点层级需要加强',
          security: '只读边界明确，没有明显风险',
          keep: j === 3 ? '保留黑白标题层级' : '保留数据契约和留白',
        }])),
        mock: true,
        summary: '共识：先定契约；分歧：视觉温度与首屏焦点。',
      })
      critiqueDone++
      reportCritiqueProgress()
      reportParticipant(participant, '交叉批判', 'done')
    }
  } else {
    const results = await Promise.all(participants.map(async (participant) => {
      try {
        reportParticipant(participant, '交叉批判', 'running')
        const response = await callBudgeted(participant, critiqueMessages(brief, proposals, interjectNote(), participant.role), planSettings, 'critique')
        const raw = extractJson(response.content)
        if (response.usage) {
          usage.promptTokens += Number(response.usage.prompt_tokens) || 0
          usage.completionTokens += Number(response.usage.completion_tokens) || 0
        }
        const row = {
          voter: participant.id,
          critiques: raw.critiques && typeof raw.critiques === 'object' ? raw.critiques : {},
          best_aesthetic: String(raw.best_aesthetic || ''),
          summary: String(raw.summary || '').slice(0, 500),
        }
        await log({ phase: 'critique', voter: participant.id, durationMs: response.durationMs, usage: response.usage || null })
        critiqueDone++
        reportCritiqueProgress()
        reportParticipant(participant, '交叉批判', 'done', response.usage)
        return row
      } catch (error) {
        const message = String(error?.message || error)
        errors.push({ phase: 'critique', voter: participant.id, error: message })
        await log({ phase: 'critique-error', voter: participant.id, error: message })
        critiqueDone++
        reportCritiqueProgress()
        reportParticipant(participant, '交叉批判', 'failed')
        return null
      }
    }))
    critiqueRows = results.filter(Boolean)
  }
  }

  if (reuse.critiques) {
    critiqueRows = Array.isArray(reuse.critiques.rows) ? reuse.critiques.rows : []
  }
  let debateDigest = reuse.critiques?.digest || ''
  if (!debateDigest) debateDigest = buildDebateDigest(critiqueRows, proposals, { anonymize: true })
  await fs.writeFile(path.join(runDir, 'critiques.json'), JSON.stringify({
    schema: 'meetingbot/critiques/v1',
    visibility: 'audit-only',
    note: 'critic identities stay in the audit; only the anonymized digest is passed to vote/decision prompts',
    rows: critiqueRows,
    digest: debateDigest,
  }, null, 2) + '\n', 'utf8')

  abortIfRequested()
  let voteRows
  let voteDone = 0
  let voteTotal = proposals.length
  const reportVoteProgress = () => { try { onProgress?.({ phase: 'Condorcet 投票', done: voteDone, total: voteTotal }) } catch {} }
  onPhase?.('Condorcet 投票')
  if (mock) {
    voteTotal = participants.length
    const mockIds = proposals.map((p) => p.id)
    const mockPreferred = mockIds[1] || mockIds[0]
    const mockScores = Object.fromEntries(mockIds.map((id, index) => [
      id,
      id === mockPreferred
        ? { architecture: 8.6, aesthetics: 8.2, security: 8.4 }
        : { architecture: Math.max(4, 8.2 - index * 0.7), aesthetics: Math.max(4, 8.5 - index * 0.5), security: Math.max(5, 8.3 - index * 0.4) },
    ]))
    const mockRanking = [mockPreferred, ...mockIds.filter((id) => id !== mockPreferred)]
    voteRows = []
    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i]
      reportParticipant(participant, 'Condorcet 投票', 'running')
      await pause()
      voteRows.push({
        voter: participant.id,
        voterTags: participant.tags,
        selfProposalId: proposals[i]?.id || null,
        vote_for: mockPreferred,
        scores: mockScores,
        ranking: mockRanking,
        reason: i === 0 ? `${mockPreferred} 的契约拆分最稳；保留其他方案中更好的排版与留白。` : `${mockPreferred} 最容易验收；其他方案的可取部分进 merge plan。`,
        mock: true,
      })
      voteDone++
      reportVoteProgress()
      reportParticipant(participant, 'Condorcet 投票', 'done')
    }
  } else {
    const results = await Promise.all(proposals.map(async (proposal) => {
      const participant = participants.find((p) => p.id === proposal.agentId)
      try {
        if (participant) reportParticipant(participant, 'Condorcet 投票', 'running')
        const response = await callBudgeted(participant, voteMessages(brief, proposals, debateDigest, interjectNote()), planSettings, 'vote')
        const raw = extractJson(response.content)
        if (response.usage) {
          usage.promptTokens += Number(response.usage.prompt_tokens) || 0
          usage.completionTokens += Number(response.usage.completion_tokens) || 0
        }
        const row = {
          voter: participant.id,
          voterTags: participant.tags,
          selfProposalId: proposal.id,
          vote_for: String(raw.vote_for || ''),
          scores: raw.scores && typeof raw.scores === 'object' ? raw.scores : {},
          ranking: Array.isArray(raw.ranking) ? raw.ranking.map(String) : [],
          reason: String(raw.reason || raw.rationale || '').slice(0, 1000),
          ...(fallbackInfo.get(proposal.id) || {}),
        }
        await log({ phase: 'vote', voter: participant.id, durationMs: response.durationMs, usage: response.usage || null })
        voteDone++
        reportVoteProgress()
        if (participant) reportParticipant(participant, 'Condorcet 投票', 'done', response.usage)
        return row
      } catch (error) {
        const message = String(error?.message || error)
        const voterId = participant?.id || proposal.agentId || ''
        errors.push({ phase: 'vote', voter: voterId, error: message })
        await log({ phase: 'vote-error', voter: voterId, error: message })
        voteDone++
        reportVoteProgress()
        if (participant) reportParticipant(participant, 'Condorcet 投票', 'failed')
        return null
      }
    }))
    voteRows = results.filter(Boolean)
  }

  const tallyResult = tally(proposals, voteRows, { dimensionWeights: config.dimensionWeights, ...config.tally })
  const ranked = tallyResult.ranked
  let winnerId = tallyResult.winnerId
  let tallyNoWinner = false
  if (!winnerId && tallyResult.audit?.method === 'no-condorcet-winner' && ranked[0]?.id) {
    // A Condorcet cycle under an explicit strict method must not destroy the
    // whole artifact. Keep the ranked display, mark ownerGate, and leave the
    // build blocked instead of pretending a majority winner exists.
    winnerId = ranked[0].id
    tallyNoWinner = true
  }
  if (!winnerId) {
    const method = tallyResult.audit?.method || ''
    const validBallots = tallyResult.audit?.validBallots ?? 0
    const detail = method === 'no-valid-ballots'
      ? 'no valid ballots; cannot elect a winner'
      : `tally could not elect a winner (${validBallots} valid ballots)`
    const failure = new Error(detail)
    failure.stage = 'vote'
    failure.tallyMethod = method
    throw failure
  }
  const winnerProposal = proposals.find((p) => p.id === winnerId)
  if (!winnerProposal) throw new Error(`tally returned unknown winner: ${winnerId || '(none)'}; proposals=${proposals.map((p) => p.id).join(',') || '(none)'}`)
  const foreman = requestedForeman || participants.find((p) => p.id === winnerProposal.agentId)
  if (!foreman) throw new Error(`winner proposal ${winnerProposal.id} has no matching participant: ${winnerProposal.agentId || '(none)'}`)
  const foremanProposal = proposals.find((p) => p.agentId === foreman.id)
  const chainSeed = foremanProposal || winnerProposal
  const foremanChain = [chainSeed, ...ranked.map((row) => row.id).filter((id) => id !== chainSeed.id).map((id) => proposals.find((p) => p.id === id))]
    .filter(Boolean)
    .filter((proposal, index, all) => all.findIndex((row) => row.id === proposal.id) === index)
    .map((proposal) => ({
      proposal: proposal.id,
      agent: participants.find((p) => p.id === proposal.agentId)?.id,
      label: participants.find((p) => p.id === proposal.agentId)?.label,
    }))
  let activeForeman = foreman
  const missing = selectedParticipants.filter((p) => !proposals.some((proposal) => proposal.agentId === p.id)).map((p) => p.id)
  const votes = { ranked, rows: voteRows, winner: winnerId, foreman: foreman.id, electedForeman: foreman.id, foremanSelection, requestedForeman: requestedForemanId || null, missing, debateDigest, foremanDebateDigest: debateDigest, tallyAudit: tallyResult.audit }
  await fs.writeFile(path.join(runDir, 'votes.json'), JSON.stringify(votes, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(runDir, 'tally-audit.json'), JSON.stringify(tallyResult.audit, null, 2) + '\n', 'utf8')

  abortIfRequested()
  let decision
  let failover = false
  onPhase?.('主 Bot 决策')
  if (mock) {
    const mockForeman = foreman
    reportParticipant(mockForeman, '主 Bot 决策', 'running')
    await pause()
    const mockWinner = proposals.find((p) => p.id === winnerId) || proposals[0]
    const otherIds = proposals.map((p) => p.id).filter((id) => id !== mockWinner.id)
    const mockAdopt = [mockWinner.id, ...otherIds.slice(0, 1)]
    const mockVetoed = otherIds.find((id) => !mockAdopt.includes(id))
    decision = validateDecision({
      adopt: mockAdopt,
      veto: mockVetoed
        ? [{ proposal: mockVetoed, category: 'scope', reason: '演示用 veto：该方向超出当前范围。' }]
        : [],
      rejected_strengths: mockVetoed
        ? [{ proposal: mockVetoed, strength: '它的视觉/交互想法仍可在后续实验中保留。' }]
        : [],
      merge_plan: `以 ${mockWinner.id} 为主干；保留其他方案中更合适的排版、留白和实现细节。`,
      risks: ['演示数据与真实数据契约需要对齐', '视觉方向仍需真机验收'],
      build_tasks: ['写 brief 的数据契约', '搭首屏与主要导航', '接一个只读 demo adapter', '截图做多模态终审'],
      code_structure: { modules: ['data-contract: read-only snapshot', 'first-screen: primary view', 'report: HTML renderer'], flow: ['read snapshot → validate → render'] },
      rationale: `${mockWinner.id} 最容易验收；其他方案的可取部分进入 merge plan。`,
    }, proposals, winnerId, { maxVetoes: config.decision?.maxVetoes ?? 1 })
    reportParticipant(mockForeman, '主 Bot 决策', 'done')
  } else {
    let decided = false
    for (const candidate of foremanChain) {
      const candidateProposal = proposals.find((p) => p.id === candidate.proposal)
      const candidateAgent = participants.find((p) => p.id === candidate.agent)
      if (!candidateProposal || !candidateAgent) continue
      const isElected = candidateAgent.id === foreman.id
      try {
        reportParticipant(candidateAgent, '主 Bot 决策', 'running')
        const response = await callBudgeted(
          candidateAgent,
          decisionMessages(
            brief,
            proposals,
            votes,
            winnerId,
            debateDigest,
            interjectNote(),
            {
              actingForeman: isElected ? null : candidateAgent,
              freezeVeto: !isElected,
              ownerSelectedForeman: foremanSelection === 'owner',
              maxVetoes: config.decision?.maxVetoes ?? 1,
            },
          ),
          decisionSettings,
          'decision',
        )
        const raw = extractJson(response.content)
        if (response.usage) {
          usage.promptTokens += Number(response.usage.prompt_tokens) || 0
          usage.completionTokens += Number(response.usage.completion_tokens) || 0
        }
        const validated = validateDecision(raw, proposals, winnerId, {
          freezeVeto: !isElected,
          freezeAdopt: !isElected,
          maxVetoes: config.decision?.maxVetoes ?? 1,
        })
        if (validated.fallback === true) {
          errors.push({ phase: 'decision-fallback', foreman: candidate.agent, error: 'decision JSON was normalized by fallback; trying next candidate' })
          await log({ phase: 'decision-fallback', foreman: candidate.agent, error: 'normalized decision rejected' })
          continue
        }
        decision = validated
        activeForeman = candidateAgent
        failover = !isElected
        decision.electedForeman = foreman.id
        decision.actingForeman = candidateAgent.id
        decision.electedProposal = winnerId
        decision.foremanSelection = foremanSelection
        decision.requestedForeman = requestedForemanId || null
        decision.failover = failover
        decision.vetoFrozen = !isElected
        if (!isElected) {
          decision.warnings.push(`foreman failover: elected foreman ${foreman.id} failed; ${candidateAgent.id} acted with veto frozen and elected proposal ${winnerId} preserved`)
        }
        decided = true
        await log({ phase: 'decision', foreman: candidate.agent, fallback: !isElected, vetoFrozen: !isElected, durationMs: response.durationMs, usage: response.usage || null })
        reportParticipant(candidateAgent, '主 Bot 决策', 'done', response.usage)
        break
      } catch (error) {
        const message = String(error?.message || error)
        errors.push({ phase: 'decision', foreman: candidate.agent, error: message })
        await log({ phase: 'decision-error', foreman: candidate.agent, error: message })
        reportParticipant(candidateAgent, '主 Bot 决策', 'failed')
      }
    }
    if (!decided) {
      activeForeman = null
      decision = fallbackDecision(proposals, winnerId, 'all foreman candidates failed')
      decision.electedForeman = foreman.id
      decision.actingForeman = null
      decision.electedProposal = winnerId
      decision.failover = false
      decision.vetoFrozen = true
      decision.ownerGate = true
      decision.warnings.push('elected foreman failed; no acting foreman was allowed to take over veto/adopt authority')
    }
  }
  if (!decision.electedForeman) decision.electedForeman = foreman.id
  if (!Object.prototype.hasOwnProperty.call(decision, 'foremanSelection')) decision.foremanSelection = foremanSelection
  if (!Object.prototype.hasOwnProperty.call(decision, 'requestedForeman')) decision.requestedForeman = requestedForemanId || null
  if (!Object.prototype.hasOwnProperty.call(decision, 'fallback')) decision.fallback = false
  if (!Object.prototype.hasOwnProperty.call(decision, 'actingForeman')) decision.actingForeman = activeForeman?.id || null
  if (!Object.prototype.hasOwnProperty.call(decision, 'failover')) decision.failover = false
  if (!Object.prototype.hasOwnProperty.call(decision, 'vetoFrozen')) decision.vetoFrozen = false
  if (missing.length) {
    decision.warnings.push(`missing participants: ${missing.join(', ')}; decision based on ${proposals.length}/${participants.length}`)
  }
  decision.quorum = { selected: selectedParticipants.length, proposals: proposals.length, validBallots: tallyResult.audit.validBallots, missing, minimum: config.quorum.min, valid: proposals.length >= config.quorum.min && tallyResult.audit.validBallots >= config.quorum.min }
  if (!decision.quorum.valid) {
    decision.blocked = true
    decision.ownerGate = true
  }
  decision.tally = {
    method: tallyResult.audit.method,
    condorcetWinner: tallyResult.audit.condorcetWinner,
    cycle: tallyResult.audit.cycle,
    selfScorePolicy: tallyResult.audit.selfScorePolicy,
    auditFile: 'tally-audit.json',
  }
  decision.foremanChain = foremanChain
  decision.workMode = workPlan.mode
  decision.routing = workPlan.routing
  decision.rolePolicy = 'proposal+critique; vote neutral'
  decision.electedForeman = foreman.id
  decision.actingForeman = activeForeman?.id || null
  decision.electedProposal = winnerId
  decision.failover = failover
  decision.vetoFrozen = !!decision.vetoFrozen || failover || !decision.quorum.valid
  decision.tallyNoWinner = tallyNoWinner
  decision.ownerGate = !!decision.ownerGate || decision.failover || !decision.quorum.valid || tallyNoWinner
  if (tallyNoWinner) decision.warnings = [...(Array.isArray(decision.warnings) ? decision.warnings : []), 'Condorcet cycle: no pairwise winner; owner review is required before build']
  decision.blocked = !!decision.blocked
  decision.repairRequiresGate = false
  decision.mockRun = mock === true
  decision.buildGate = {
    required: config.buildGate?.required !== false,
    status: 'unverified',
    reason: '',
    quorumValid: decision.quorum.valid,
    commands: gateCommandList(config),
  }
  votes.actingForeman = decision.actingForeman
  votes.failover = decision.failover
  votes.vetoFrozen = decision.vetoFrozen
  await fs.writeFile(path.join(runDir, 'votes.json'), JSON.stringify(votes, null, 2) + '\n', 'utf8')
  const gateCommands = Array.isArray(decision.buildGate?.commands) ? decision.buildGate.commands : []
  const configDir = path.dirname(config.path || path.resolve(configPath))
  const gateCwd = config.buildGate?.cwd
    ? path.resolve(configDir, config.buildGate.cwd)
    : configDir
  if (!mock) decision.buildGate = { ...decision.buildGate, cwd: gateCwd }
  const needsGateFile = !mock
    && gateCommands.length > 0
    && config.buildGate?.runOnMeeting !== false
  if (needsGateFile) {
    // runBuildGate reads decision.json. Only create the interim file when a gate
    // is actually going to run; otherwise the final write below is the only one.
    await fs.writeFile(path.join(runDir, 'decision.json'), JSON.stringify({
      ...decision,
      winner: winnerId,
      foreman: activeForeman?.id || null,
      electedForeman: decision.electedForeman,
      actingForeman: decision.actingForeman,
    }, null, 2) + '\n', 'utf8')
  }

  // The decision is not buildable merely because it exists. When gate commands
  // are configured, run them now. runBuildGate writes gate.json and also
  // updates decision.json; we still merge its returned result explicitly so
  // the contract does not depend on that side effect.
  if (mock) {
    decision.buildGate = {
      ...decision.buildGate,
      status: 'skipped',
      reason: 'mock run; gate commands were not executed',
      checkedAt: new Date().toISOString(),
    }
  } else if (gateCommands.length && config.buildGate?.runOnMeeting !== false) {
    try {
      const gateResult = await runBuildGate({
        runDir,
        commands: gateCommands,
        cwd: gateCwd,
        timeoutMs: Math.max(1000, Number(config.buildGate?.timeoutMs) || 300000),
      })
      decision.buildGate = { ...decision.buildGate, ...gateResult }
      // Gate results may only add blocks, never clear an existing quorum or
      // failover block. This keeps blocked/ownerGate fail-closed regardless of
      // merge order.
      if (gateResult.blocked === true) decision.blocked = true
      if (gateResult.ownerGate === true) decision.ownerGate = true
    } catch (error) {
      decision.blocked = true
      decision.ownerGate = true
      decision.buildGate = {
        ...decision.buildGate,
        status: 'failed',
        reason: String(error?.message || error),
        checkedAt: new Date().toISOString(),
      }
      // ownerGateReasons -> warnings below is the single warning path; do not
      // add a second near-duplicate warning here.
    }
  }
  const gateSatisfied = isBuildGateSatisfied(decision)
  const ownerGateReasons = []
  if (mock) ownerGateReasons.push('mock run: build gate was not executed; build is not authorized')
  if (decision.quorum?.valid === false) ownerGateReasons.push(`quorum invalid: ${decision.quorum.proposals} proposals < minimum ${decision.quorum.minimum}; build must not start without owner override`)
  if (decision.failover) ownerGateReasons.push('decision completed by an acting foreman (failover); veto was frozen')
  if (decision.fallback) ownerGateReasons.push('foreman decision fell back; owner review is required before build')
  if (decision.buildGate?.status === 'failed') ownerGateReasons.push(`build gate failed: ${decision.buildGate.reason || 'see gate.json'}`)
  if (decision.buildGate?.status === 'unverified' && decision.buildGate?.required === true) {
    if (!decision.buildGate.commands?.length) {
      ownerGateReasons.push('no build gate commands configured')
    } else if (config.buildGate?.runOnMeeting === false) {
      ownerGateReasons.push('build gate execution is disabled (runOnMeeting: false); run commands manually')
    } else {
      ownerGateReasons.push('build gate commands are configured but have not run')
    }
  }
  if (decision.repairRequiresGate) ownerGateReasons.push('decision was repaired; build gate must be re-run')
  decision.ownerGateReasons = [...new Set(ownerGateReasons)]
  if (decision.ownerGateReasons.length) {
    decision.ownerGate = true
    for (const reason of decision.ownerGateReasons) {
      if (!decision.warnings.includes(reason)) decision.warnings.push(reason)
    }
  }
  decision.canBuild = !decision.blocked && !decision.ownerGate && gateSatisfied
  decision.schema = 'meetingbot/decision/v1'
  decision.winner = winnerId
  decision.foreman = activeForeman?.id || null
  decision.parentRunId = String(parentRunId || '') || null
  await fs.writeFile(path.join(runDir, 'decision.json'), JSON.stringify(decision, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify({
    schema: 'meetingbot/run/v1',
    runId,
    createdAt: previousMeta.createdAt || new Date().toISOString(),
    resumedAt: resumePath ? new Date().toISOString() : undefined,
    mode: mock ? 'mock' : 'live',
    executionIntent: executionIntent === 'execute' ? 'execute' : 'decide',
    permissionMode: String(permissionMode || previousMeta.permissionMode || '') || undefined,
    parentRunId: String(parentRunId || '') || null,
    cache: stageCache.stats(),
    briefImages: briefImages.images.map((image) => ({ path: path.relative(runDir, image.path), mime: image.mime })),
    briefImageWarnings,
    mockDelayMs: mock ? delayMs : 0,
    mockSize: mock ? mockProposals(participants, mockSize).length : 0,
    brief: path.resolve(briefPath),
    config: path.resolve(configPath),
    roster: publicRoster(config),
    selected: publicRoster({ participants: selectedParticipants }),
    selection,
    quorum: { ...config.quorum, valid: decision.quorum.valid },
    dimensionWeights: config.dimensionWeights,
    computerAccess: config.computerAccess,
    winner: winnerId,
    foreman: activeForeman?.id || null,
    electedForeman: decision.electedForeman,
    foremanSelection: decision.foremanSelection || foremanSelection,
    requestedForeman: decision.requestedForeman || requestedForemanId || null,
    actingForeman: decision.actingForeman,
    failover: decision.failover,
    fallback: decision.fallback,
    vetoFrozen: decision.vetoFrozen,
    ownerGateReasons: decision.ownerGateReasons || [],
    rolePolicy: decision.rolePolicy,
    foremanChain,
    workMode: workPlan.mode,
    routing: workPlan.routing,
    roles: workPlan.roles,
    fallbackVoters: [...fallbackInfo.entries()].map(([proposal, info]) => ({ proposal, ...info })),
    buildGate: decision.buildGate,
    canBuild: decision.canBuild,
    blocked: decision.blocked,
    budget,
    usage,
    errors,
    interjections: interjectionsSoFar(),
  }, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(runDir, 'decision.md'), renderDecision({ brief, proposals, ranked, voteRows, decision, winnerProposal, foreman: activeForeman, electedForeman: foreman, errors }), 'utf8')
  await fs.writeFile(path.join(runDir, 'report.html'), renderHtml({ brief, proposals, ranked, voteRows, decision, winnerProposal, foreman: activeForeman, electedForeman: foreman, errors }), 'utf8')
  return { runDir, decision, canBuild: decision.canBuild, ranked, winnerId, foreman: activeForeman, foremanSelection: decision.foremanSelection || foremanSelection, proposals, errors, workMode: workPlan.mode, routing: workPlan.routing, roles: workPlan.roles, budget, usage, interjections: interjectionsSoFar(), parentRunId: String(parentRunId || '') || null, executionIntent: executionIntent === 'execute' ? 'execute' : 'decide', mockSize: mock ? proposals.length : 0, cache: stageCache.stats() }
}

export async function repairDecision({ runDir, configPath, timeoutMs = 600000 }) {
  const dir = path.resolve(runDir)
  const brief = (await fs.readFile(path.join(dir, 'brief.md'), 'utf8')).trim()
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
  const config = loadConfig(configPath || meta.config, { requireKeys: true })
  config.timeoutMs = Math.max(120000, Math.min(900000, Number(timeoutMs) || 600000))
  const proposalDir = path.join(dir, 'proposals')
  const names = (await fs.readdir(proposalDir)).filter((name) => /^P\d+\.json$/.test(name)).sort()
  const proposals = []
  for (const name of names) proposals.push(JSON.parse(await fs.readFile(path.join(proposalDir, name), 'utf8')))
  const votes = JSON.parse(await fs.readFile(path.join(dir, 'votes.json'), 'utf8'))
  const repairedFrom = {
    foreman: votes.foreman ?? null,
    electedForeman: votes.electedForeman ?? null,
    actingForeman: votes.actingForeman ?? null,
    failover: votes.failover ?? null,
  }
  const winnerId = votes.winner
  const winnerProposal = proposals.find((p) => p.id === winnerId)
  if (!votes.electedForeman && votes.failover !== false) {
    throw new Error('cannot verify elected foreman in legacy run (no electedForeman and failover unknown); refusing to repair')
  }
  const electedId = votes.electedForeman || votes.foreman
  if (!electedId) throw new Error('cannot determine elected foreman from legacy run; refusing to repair')
  const foreman = config.participants.find((p) => p.id === electedId)
  if (!foreman || !winnerProposal) throw new Error('cannot resolve foreman or winner from run data')
  let response = null
  let lastError = null
  let attempts = 0
  let settings = { ...config, maxTokens: Number.isFinite(Number(config.maxTokens)) ? Number(config.maxTokens) : 2200 }
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    try {
      response = await callChat(
        foreman,
        decisionMessages(brief, proposals, votes, winnerId, votes.foremanDebateDigest || '', '', {
          maxVetoes: config.decision?.maxVetoes ?? 1,
        }),
        settings,
      )
      if (['length', 'max_tokens'].includes(String(response.finishReason || '').toLowerCase())) throw new Error(`${foreman.id}: output length (${response.finishReason})`)
      break
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      const canEscalate = /empty content|length|timed out|timeout|aborted/i.test(message)
      if (!canEscalate || attempt === 1) throw error
      settings = {
        ...settings,
        maxTokens: Math.min(config.decision?.budgetEscalationCap ?? 50000,
          Math.round(settings.maxTokens * (config.decision?.budgetEscalationFactor ?? 1.6))),
      }
    }
  }
  if (!response) throw lastError || new Error('decision repair produced no response')
  const raw = extractJson(response.content)
  const decision = validateDecision(raw, proposals, winnerId, { maxVetoes: config.decision?.maxVetoes ?? 1 })
  const selected = Array.isArray(meta.selected)
    ? meta.selected.map((p) => typeof p === 'string' ? p : p?.id).filter(Boolean)
    : []
  const missing = selected.filter((id) => !proposals.some((p) => p.agentId === id))
  decision.quorum = { selected: selected.length || proposals.length, proposals: proposals.length, missing, minimum: config.quorum.min, valid: proposals.length >= config.quorum.min }
  if (!decision.quorum.valid) {
    decision.blocked = true
    decision.ownerGate = true
  }
  decision.tally = { method: votes.tallyAudit?.method || 'unknown', condorcetWinner: votes.tallyAudit?.condorcetWinner || null, cycle: votes.tallyAudit?.cycle || false, selfScorePolicy: votes.tallyAudit?.selfScorePolicy || null, auditFile: 'tally-audit.json' }
  decision.electedForeman = foreman.id
  decision.actingForeman = foreman.id
  decision.electedProposal = winnerId
  decision.failover = false
  decision.vetoFrozen = !!decision.vetoFrozen || !decision.quorum.valid
  decision.rolePolicy = 'proposal+critique; vote neutral'
  const configDir = path.dirname(config.path || path.resolve(configPath))
  const gateCwd = config.buildGate?.cwd
    ? path.resolve(configDir, config.buildGate.cwd)
    : configDir
  const repairCommands = gateCommandList(config)
  decision.buildGate = {
    required: config.buildGate?.required !== false,
    status: 'unverified',
    reason: repairCommands.length ? 'repaired; gate not re-run' : 'repaired; no gate commands configured',
    quorumValid: decision.quorum.valid,
    cwd: gateCwd,
    commands: repairCommands,
  }
  decision.blocked = !!decision.blocked || !decision.quorum.valid
  decision.repairRequiresGate = true
  decision.schema = 'meetingbot/decision/v1'
  decision.winner = winnerId
  decision.foreman = foreman.id
  decision.repairedFrom = repairedFrom
  decision.ownerGateReasons = [repairCommands.length
    ? `decision was repaired; re-run gate commands in ${gateCwd} before build`
    : 'decision was repaired; no build gate commands are configured']
  if (decision.quorum?.valid === false) decision.ownerGateReasons.push(`quorum invalid: ${decision.quorum.proposals} proposals < minimum ${decision.quorum.minimum}; build must not start without owner override`)
  decision.ownerGate = true
  decision.canBuild = false
  for (const reason of decision.ownerGateReasons) {
    if (!decision.warnings.includes(reason)) decision.warnings.push(reason)
  }
  const errors = Array.isArray(meta.errors) ? meta.errors : []
  errors.push({ phase: 'decision-repair', level: 'info', foreman: foreman.id, durationMs: response.durationMs, repaired: true, attempts })
  // Repair calls cost real tokens; keep them visible in the usage ledger.
  if (response.usage) {
    const prior = meta.usage && typeof meta.usage === 'object' ? meta.usage : {}
    meta.usage = {
      ...prior,
      promptTokens: (Number(prior.promptTokens) || 0) + (Number(response.usage.prompt_tokens) || 0),
      completionTokens: (Number(prior.completionTokens) || 0) + (Number(response.usage.completion_tokens) || 0),
    }
  }
  try {
    await fs.appendFile(path.join(dir, 'transcript.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase: 'decision-repair', foreman: foreman.id, durationMs: response.durationMs, usage: response.usage || null, attempts }) + '\n', 'utf8')
  } catch { /* transcript is best-effort */ }
  decision.repair = { foreman: foreman.id, durationMs: response.durationMs, attempts, repairedAt: new Date().toISOString() }
  meta.foreman = foreman.id
  meta.electedForeman = foreman.id
  meta.actingForeman = foreman.id
  meta.failover = false
  meta.vetoFrozen = decision.vetoFrozen
  meta.canBuild = decision.canBuild
  meta.blocked = decision.blocked
  meta.buildGate = decision.buildGate
  meta.ownerGateReasons = decision.ownerGateReasons
  meta.repairedFrom = repairedFrom
  meta.errors = errors
  votes.foreman = foreman.id
  votes.electedForeman = foreman.id
  votes.actingForeman = foreman.id
  votes.failover = false
  votes.vetoFrozen = decision.vetoFrozen
  await fs.writeFile(path.join(dir, 'votes.json'), JSON.stringify(votes, null, 2) + '\n', 'utf8')
  const repaired = { ...decision, schema: 'meetingbot/decision/v1', winner: winnerId, foreman: foreman.id, electedForeman: foreman.id, actingForeman: foreman.id }
  const repairedErrors = validateDecisionDocument(repaired)
  if (repairedErrors.length) throw new Error(`repair produced an invalid decision: ${repairedErrors.join('; ')}`)
  await fs.writeFile(path.join(dir, 'decision.json'), JSON.stringify(repaired, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(dir, 'decision.md'), renderDecision({ brief, proposals, ranked: votes.ranked, voteRows: votes.rows, decision, winnerProposal, foreman, electedForeman: foreman, errors }), 'utf8')
  await fs.writeFile(path.join(dir, 'report.html'), renderHtml({ brief, proposals, ranked: votes.ranked, voteRows: votes.rows, decision, winnerProposal, foreman, electedForeman: foreman, errors }), 'utf8')
  return { runDir: dir, decision, canBuild: decision.canBuild, foreman, durationMs: response.durationMs }
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return JSON.stringify(String(value))
}

export function renderDecision({ brief, proposals, ranked, voteRows, decision, winnerProposal, foreman, electedForeman = foreman, errors }) {
  const lines = []
  const elected = electedForeman || foreman
  lines.push(
    '---',
    'schema: meetingbot/decision/v1',
    `winner: ${yamlScalar(decision.winner || winnerProposal.id)}`,
    `foreman: ${yamlScalar(decision.foreman ?? null)}`,
    `electedForeman: ${yamlScalar(decision.electedForeman ?? elected?.id ?? null)}`,
    `actingForeman: ${yamlScalar(decision.actingForeman ?? null)}`,
    `failover: ${decision.failover === true}`,
    `fallback: ${decision.fallback === true}`,
    `ownerGate: ${decision.ownerGate === true}`,
    `canBuild: ${decision.canBuild === true}`,
    `gateStatus: ${yamlScalar(decision.buildGate?.status ?? null)}`,
    `mockRun: ${decision.mockRun === true}`,
    `parentRunId: ${yamlScalar(decision.parentRunId ?? null)}`,
    '---',
    '',
  )
  const actingLabel = foreman ? `${foreman.label} (${foreman.id})` : 'none — owner review required'
  lines.push('# MeetingBot decision', '')
  lines.push(`**Elected proposal:** ${winnerProposal.id} · ${winnerProposal.agentLabel}`, '')
  lines.push(`**Elected foreman:** ${elected ? `${elected.label} (${elected.id})` : 'unknown'}`, '')
  lines.push(`**Acting foreman:** ${actingLabel}${decision.failover ? ' · FAILOVER' : ''}`, '')
  lines.push(`**Veto power:** ${decision.vetoFrozen ? 'frozen' : 'available'}` , '')
  lines.push(`**Can build:** ${decision.canBuild === true ? 'yes' : 'no (gate/owner approval required)'}`, '')
  lines.push('## Votes', '', '| Proposal | Overall | Architecture | Aesthetics | Security | First-place | Self avg | Others avg | Δ |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const row of ranked) lines.push(`| ${row.id} | ${row.average.toFixed(2)} | ${(row.architecture || 0).toFixed(2)} | ${(row.aesthetics || 0).toFixed(2)} | ${(row.security || 0).toFixed(2)} | ${row.first} | ${row.selfAverage == null ? '—' : row.selfAverage.toFixed(2)} | ${row.otherAverage == null ? '—' : row.otherAverage.toFixed(2)} | ${row.selfDelta == null ? '—' : (row.selfDelta > 0 ? '+' : '') + row.selfDelta.toFixed(2)} |`)
  lines.push('', '## Proposals', '')
  for (const p of proposals) {
    lines.push(`### ${p.id} · ${p.agentLabel}`, '')
    lines.push(`- **理解：** ${p.understanding || '—'}`)
    lines.push(`- **架构：** ${p.architecture || '—'}`)
    lines.push(`- **审美：** ${p.aesthetic || '—'}`)
    lines.push(`- **风险：** ${p.risks.length ? p.risks.join('；') : '—'}`)
    lines.push('')
  }
  lines.push('## Decision', '')
  lines.push(`- **Adopt:** ${decision.adopt.join(', ') || '—'}`)
  lines.push(`- **Veto:** ${decision.veto.length ? decision.veto.map((v) => `${v.proposal} (${v.category}) — ${v.reason}`).join('；') : '—'}`)
  lines.push(`- **Merge plan:** ${decision.merge_plan || '—'}`)
  lines.push(`- **Rationale:** ${decision.rationale || '—'}`)
  lines.push(`- **Elected proposal:** ${decision.electedProposal || winnerProposal.id}`)
  lines.push(`- **Elected foreman:** ${decision.electedForeman || elected.id}`)
  lines.push(`- **Acting foreman:** ${decision.actingForeman || 'none — owner review required'}`)
  lines.push(`- **Failover:** ${decision.failover ? 'yes' : 'no'}`)
  lines.push(`- **Role policy:** ${decision.rolePolicy || 'not recorded'}`)
  lines.push('', '### Rejected proposal strengths', '')
  lines.push(...(decision.rejected_strengths?.length ? decision.rejected_strengths.map((x) => `- **${x.proposal}:** ${x.strength}`) : ['- none recorded']))
  lines.push('', '### Risks of adopted direction', '')
  lines.push(...(decision.risks?.length ? decision.risks.map((x) => `- ${x}`) : ['- none recorded']))
  lines.push('', '### Initial code structure', '')
  if (decision.code_structure?.modules?.length) {
    lines.push('**Modules**', '')
    for (const x of decision.code_structure.modules) lines.push(`- ${x}`)
  } else lines.push('- no module structure recorded')
  if (decision.code_structure?.flow?.length) {
    lines.push('', '**Flow**', '')
    for (const x of decision.code_structure.flow) lines.push(`- ${x}`)
  }
  lines.push('', '### Build tasks', '')
  lines.push(...(decision.build_tasks.length ? decision.build_tasks.map((task, i) => `${i + 1}. ${task}`) : ['—']))
  lines.push('', '## Minority ideas kept', '')
  for (const row of voteRows) {
    if (row.reason) lines.push(`- **${row.voter}:** ${row.reason}`)
  }
  lines.push('', '## Quorum', '')
  lines.push(`- Selected: ${decision.quorum?.selected ?? '—'} / Proposals: ${decision.quorum?.proposals ?? '—'} / Valid ballots: ${decision.quorum?.validBallots ?? '—'} / Minimum: ${decision.quorum?.minimum ?? '—'}`)
  lines.push(`- Missing: ${decision.quorum?.missing?.length ? decision.quorum.missing.join(', ') : 'none'}`)
  lines.push(`- Valid: ${decision.quorum?.valid === false ? 'NO — build must not start' : 'yes'}`)
  lines.push('', '## Tally audit', '')
  lines.push(`- Method: ${decision.tally?.method || '—'}`)
  lines.push(`- Condorcet winner: ${decision.tally?.condorcetWinner || 'none (cycle / fallback)'}`)
  lines.push(`- Audit file: tally-audit.json`)
  lines.push(`- Self-score policy: ${decision.tally?.selfScorePolicy || '—'}`)
  lines.push('', '## Warnings', '')
  lines.push(...(decision.warnings.length ? decision.warnings.map((w) => `- ${w}`) : ['- none']))
  lines.push('', '## Owner gate', '')
  lines.push('This run produced a meeting artifact. The meeting itself did not write product code; configured build-gate commands may have run and are recorded in gate.json.')
  lines.push('The owner should approve the decision before build starts.')
  const gateReasons = Array.isArray(decision.ownerGateReasons) ? decision.ownerGateReasons.filter(Boolean) : []
  if (gateReasons.length) {
    lines.push('', '**Build is blocked for these reasons:**')
    for (const reason of gateReasons) lines.push(`- ${reason}`)
  } else if (decision.ownerGate || decision.failover || decision.quorum?.valid === false) {
    lines.push('', '**Owner gate is mandatory for this run.**')
  }
  if (decision.repair) {
    lines.push('', '## Repair', '')
    lines.push(`- ${decision.repair.foreman} · ${decision.repair.attempts} attempt(s) · ${decision.repair.durationMs}ms`)
  }
  const errorRows = errors.filter((e) => e.level !== 'info')
  if (errorRows.length) {
    lines.push('', '## Errors', '')
    for (const e of errorRows) lines.push(`- ${e.phase}/${e.agent || e.voter || '?'} — ${e.error}`)
  }
  return lines.join('\n') + '\n'
}

export function renderHtml({ brief, proposals, ranked, voteRows, decision, winnerProposal, foreman, electedForeman = foreman, errors }) {
  const elected = electedForeman || foreman
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const voteRowsHtml = ranked.map((row) => `<tr><td>${esc(row.id)}</td><td>${row.average.toFixed(2)}</td><td>${(row.architecture || 0).toFixed(2)}</td><td>${(row.aesthetics || 0).toFixed(2)}</td><td>${(row.security || 0).toFixed(2)}</td><td>${row.first}</td><td>${row.selfAverage == null ? '—' : row.selfAverage.toFixed(2)}</td><td>${row.otherAverage == null ? '—' : row.otherAverage.toFixed(2)}</td><td>${row.selfDelta == null ? '—' : (row.selfDelta > 0 ? '+' : '') + row.selfDelta.toFixed(2)}</td></tr>`).join('')
  const proposalsHtml = proposals.map((p) => `
    <article class="card">
      <header><b>${esc(p.id)}</b><span>${esc(p.agentLabel)}</span></header>
      <p><b>理解</b> ${esc(p.understanding)}</p>
      <p><b>架构</b> ${esc(p.architecture)}</p>
      <p><b>审美</b> ${esc(p.aesthetic)}</p>
      <p><b>风险</b> ${esc(p.risks.join('；') || '—')}</p>
    </article>`).join('')
  const vetoHtml = decision.veto.length
    ? decision.veto.map((v) => `<li><b>${esc(v.proposal)}</b> · ${esc(v.category)} — ${esc(v.reason)}</li>`).join('')
    : '<li>无</li>'
  const tasksHtml = decision.build_tasks.length ? decision.build_tasks.map((t) => `<li>${esc(t)}</li>`).join('') : '<li>—</li>'
  const warningsHtml = decision.warnings.length ? decision.warnings.map((w) => `<li>${esc(w)}</li>`).join('') : '<li>无</li>'
  const strengthsHtml = decision.rejected_strengths?.length ? decision.rejected_strengths.map((x) => `<li><b>${esc(x.proposal)}</b> ${esc(x.strength)}</li>`).join('') : '<li>无</li>'
  const risksHtml = decision.risks?.length ? decision.risks.map((x) => `<li>${esc(x)}</li>`).join('') : '<li>无</li>'
  const structureHtml = decision.code_structure?.modules?.length ? decision.code_structure.modules.map((x) => `<li>${esc(x)}</li>`).join('') : '<li>无</li>'
  const visibleErrors = errors.filter((e) => e.level !== 'info')
  const errorsHtml = visibleErrors.length ? visibleErrors.map((e) => `<li>${esc(e.phase)} / ${esc(e.agent || e.voter || '?')} — ${esc(e.error)}</li>`).join('') : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeetingBot · ${esc(winnerProposal.id)}</title>
<style>
:root{color-scheme:dark;--bg:#0b1118;--card:#121c26;--line:#263847;--text:#e5eef5;--muted:#8ba0b0;--cyan:#69d1e8;--amber:#e7b46b;--green:#83d6a5;--rose:#e98b9b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:40px 22px 80px}h1{font-size:34px;margin:0 0 6px}h2{font-size:18px;color:var(--cyan);margin:34px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
p{color:#cbd8e2;margin:7px 0}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}@media(max-width:800px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}.card header{display:flex;justify-content:space-between;color:var(--muted);margin-bottom:8px}
table{width:100%;border-collapse:collapse}td,th{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:500}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--muted);font-size:12px;margin-right:6px}
ul{padding-left:20px}li{margin:5px 0}.veto{color:var(--rose)}.adopt{color:var(--green)}.merge{color:var(--amber)}
</style></head><body><main>
<h1>MeetingBot</h1><p class="muted">多模型设计会议 · 匿名提案 · 包工头决策</p>
<p><span class="badge">Elected ${esc(winnerProposal.id)}</span>${decision.repair ? '<span class="badge">REPAIRED</span>' : ''}<span class="badge">Elected foreman ${esc(elected.label)}</span><span class="badge">Acting ${esc(foreman ? foreman.label : 'none')}</span>${decision.failover ? '<span class="badge">FAILOVER</span>' : ''}<span class="badge">${decision.vetoFrozen ? 'veto frozen' : 'veto available'}</span><span class="badge">${decision.canBuild === true ? 'can build' : 'build blocked'}</span><span class="badge">meeting only</span></p>
<h2>需求</h2><article class="card"><p>${esc(brief).replace(/\n/g, '<br>')}</p></article>
<h2>投票</h2><table><thead><tr><th>提案</th><th>总分</th><th>架构</th><th>审美</th><th>安全</th><th>第一名</th><th>自评</th><th>他人</th><th>Δ</th></tr></thead><tbody>${voteRowsHtml}</tbody></table>
<p class="muted">Quorum valid: ${decision.quorum?.valid === false ? 'NO — build must not start' : 'yes'} · Self-score policy: ${esc(decision.tally?.selfScorePolicy || '—')} · Role policy: ${esc(decision.rolePolicy || '—')}</p>
<div class="grid"><section><h2>提案</h2>${proposalsHtml}</section><section>
<h2>决策</h2><article class="card"><p class="adopt"><b>采纳</b> ${esc(decision.adopt.join(', ') || '—')}</p>
<p class="veto"><b>否决</b></p><ul>${vetoHtml}</ul>
<p class="merge"><b>合并计划</b> ${esc(decision.merge_plan || '—')}</p>
<p><b>理由</b> ${esc(decision.rationale || '—')}</p></article>
<h2>被否决方案的优点</h2><ul>${strengthsHtml}</ul>
<h2>采纳方向的风险</h2><ul>${risksHtml}</ul>
<h2>初始代码结构</h2><ul>${structureHtml}</ul>
<h2>构建任务</h2><ul>${tasksHtml}</ul>
</section></div>
<h2>投票理由 / 少数派审美</h2>${voteRows.map((row) => `<article class="card"><p><b>${esc(row.voter)}</b> ${esc(row.reason || '—')}</p></article>`).join('')}
${decision.repair ? `<h2>Repair</h2><p class="muted">Repaired by ${esc(decision.repair.foreman)} · ${esc(decision.repair.attempts)} attempt(s) · ${esc(decision.repair.durationMs)}ms</p>` : ''}
<h2>警告</h2><ul>${warningsHtml}</ul>
${errorsHtml ? `<h2>错误</h2><ul>${errorsHtml}</ul>` : ''}
<p class="muted" style="margin-top:36px">会议产物 only. The meeting did not write product code; configured build-gate commands may have run and are recorded in gate.json.</p>
</main></body></html>`
}
