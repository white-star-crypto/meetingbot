import fs from 'node:fs'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'
import { callChat, extractJson } from './providers.mjs'
import { resolveParticipant } from './model-aliases.mjs'

const VISION_IDS = ['doubao-turbo', 'doubao-pro', 'qwen-flash', 'doubao']
const REVIEW_PROMPT = `你是合议（MeetingBot）的多模态验收员。看这张应用截图，按用户给出的验收标准判断是否通过。

要求：
- 只评价截图里真实可见的东西，不要猜测代码或后台。
- 如果截图模糊、空白、不是目标应用，直接判失败。
- pass=false 的门槛：任一 high 问题，或 score < 7。
- 问题必须具体到位置和改法，不要写空话。

严格只输出一个 JSON 对象，不要 Markdown：
{
  "pass": true,
  "score": 0,
  "firstImpression": "一句话",
  "issues": [{"area":"布局/字体/间距/状态/交互/其他","severity":"high/medium/low","problem":"具体问题","fix":"具体改法"}],
  "mustFix": ["最多 3 条"],
  "keep": ["最多 3 条"]
}`

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('vision review is not an object')
  const issues = Array.isArray(raw.issues) ? raw.issues.map((issue) => ({
    area: String(issue?.area || '其他').slice(0, 40),
    severity: ['high', 'medium', 'low'].includes(issue?.severity) ? issue.severity : 'medium',
    problem: String(issue?.problem || '').slice(0, 500),
    fix: String(issue?.fix || '').slice(0, 500),
  })).filter((issue) => issue.problem) : []
  const mustFix = Array.isArray(raw.mustFix) ? raw.mustFix.map(String).filter(Boolean).slice(0, 6) : []
  const keep = Array.isArray(raw.keep) ? raw.keep.map(String).filter(Boolean).slice(0, 6) : []
  const score = Math.max(0, Math.min(10, Number(raw.score) || 0))
  const high = issues.some((issue) => issue.severity === 'high')
  return {
    pass: raw.pass === true && !high && score >= 7,
    score,
    firstImpression: String(raw.firstImpression || '').slice(0, 300),
    issues,
    mustFix,
    keep,
  }
}

export function visionCandidates(config) {
  const out = []
  for (const value of VISION_IDS) {
    const participant = resolveParticipant(config?.participants || [], value)
    if (participant && !out.some((p) => p.id === participant.id)) out.push(participant)
  }
  return out
}

export async function reviewImage({ config, imagePath, criteria, agentIds = [], maxTokens = 4000, allowedRoots = [path.join(resolveDataRoot(), 'state', 'captures'), path.join(resolveDataRoot(), 'state', 'vision-snapshots'), path.join(resolveDataRoot(), 'panel-screenshots')] }) {
  const absolute = path.resolve(imagePath)
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).map((root) => path.resolve(root))
  if (!fs.existsSync(absolute)) throw new Error('image not found: ' + absolute)
  const real = fs.realpathSync(absolute)
  const allowed = roots.some((root) => {
    try { const realRoot = fs.realpathSync(root); return real === realRoot || real.startsWith(realRoot + path.sep) } catch {
      // Only reachable when the root does not exist yet; lexical comparison
      // is safe because the image itself has already been realpath-resolved.
      return real === root || real.startsWith(root + path.sep)
    }
  })
  if (!allowed) throw new Error('image path is outside the allowed workspace')
  for (const root of roots) {
    try { fs.mkdirSync(root, { recursive: true }) } catch { /* root may be read-only */ }
  }
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error('image path is not a file: ' + absolute)
  if (stat.size > 12 * 1024 * 1024) throw new Error('image is larger than 12MB')
  const b64 = fs.readFileSync(absolute).toString('base64')
  const candidates = (agentIds.length
    ? agentIds.map((id) => resolveParticipant(config.participants || [], id)).filter(Boolean)
    : visionCandidates(config))
    .filter((participant) => participant.apiKey)
  if (!candidates.length) throw new Error('no multimodal model with an API key is available')
  const text = String(criteria || '').trim() || '界面要简约、像人类产品、信息层级清楚，不能像花哨 AI 仪表盘。'
  const attempts = []
  for (const participant of candidates) {
    try {
      const response = await callChat({ ...participant, reasoningEffort: participant.reasoningEffort || 'low' }, [
        { role: 'system', content: 'You are a strict visual acceptance reviewer. Return only one JSON object.' },
        { role: 'user', content: [
          { type: 'text', text: `${REVIEW_PROMPT}\n\n验收标准：\n${text}` },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ] },
      ], { temperature: 0.2, maxTokens, timeoutMs: 300000 })
      const parsed = normalizeReview(extractJson(response.content))
      return {
        ok: true,
        reviewer: { id: participant.id, label: participant.label, model: participant.model },
        review: parsed,
        usage: response.usage || null,
        durationMs: response.durationMs,
        attempts,
      }
    } catch (error) {
      attempts.push({ id: participant.id, error: String(error?.message || error).slice(0, 500) })
    }
  }
  return { ok: false, error: 'all multimodal reviewers failed', attempts }
}
