import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const dir = path.resolve('creative/pelican-collab-v2')
fs.mkdirSync(path.join(dir, 'plans'), { recursive: true })
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const ids = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']
const task = `绘制一只戴安全帽的鹈鹕沿海岸线骑自行车，包含海浪、沙滩、棕榈树，使用SVG并加入腿部IK动画、车轮旋转和背景视差效果。`
const planPrompt = `你是共享创作的子 Bot。不要画完整成品，只提出这张动画 SVG 的构图与实现建议。

原始任务：
${task}

请给出 800–1200 字建议，必须同时覆盖：
1. 主体关系：鹈鹕如何坐在自行车上、头盔和喙囊怎么处理；
2. 海岸、海浪、沙滩、棕榈的前后层次；
3. 动画实现逻辑：腿部 IK 的髋/膝/踝节点和踩踏相位怎么组织；车轮/脚踏怎么转；鹈鹕和车怎么实打实向前移动；背景各层如何以不同速度视差；
4. 你建议的配色、光影、线条、构图；
5. 最容易画错/穿模/截断的地方。
只输出文字建议，不要 SVG，不要 JSON，不要代码补丁。`

const finalPrompt = `你是主 Bot。下面是 7 位子 Bot 对同一张动画 SVG 的构图与动画实现建议。请合成唯一一张成品。

原始任务：
${task}

硬性要求：
- 一只戴安全帽的鹈鹕骑在自行车上，沿海岸线前进；主体关系不能画反。
- 必须有真实动画：双腿髋-膝-踝近似 IK 踩踏、车轮与脚踏旋转、翅膀/羽毛动态、主体整体前移、背景海浪/棕榈/沙滩不同速度视差。
- 1200x700，只用 SVG + SMIL，不依赖外部资源。
- 完整合法 XML，必须闭合 </svg>。
- 只输出 SVG，不要 Markdown，不要解释。
- 输出预算 50000 tokens；优先保证完整、可运行、可看。

七份建议：
`

const started = Date.now()
const logs = []
const plans = []
await Promise.all(ids.map(async (id) => {
  const p = config.participants.find((x) => x.id === id)
  if (!p) { plans.push({ id, error: 'missing' }); return }
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are a senior motion designer and SVG architect. Be concrete about animation implementation.' },
      { role: 'user', content: planPrompt },
    ], { temperature: 0.8, maxTokens: 30000, timeoutMs: 900000 })
    const text = String(r.content || '').trim()
    fs.writeFileSync(path.join(dir, 'plans', `${id}.md`), text, 'utf8')
    plans.push({ id, ok: !!text, chars: text.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null })
  } catch (e) {
    plans.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
  }
}))
plans.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
const planText = plans.map((p) => `### ${p.id}\n${p.ok ? fs.readFileSync(path.join(dir, 'plans', `${p.id}.md`), 'utf8') : `FAILED: ${p.error}`}`).join('\n\n')

const finalAttempts = []
let finalSvg = ''
let used = ''
for (const id of ['minimax-flash', 'qwen-flash', 'glm-flash', 'ds-flash']) {
  const p = config.participants.find((x) => x.id === id)
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are the elected foreman. Output only one complete valid animated SVG.' },
      { role: 'user', content: finalPrompt + planText },
    ], { temperature: 0.72, maxTokens: 50000, timeoutMs: 1200000 })
    const raw = String(r.content || '').trim()
    fs.writeFileSync(path.join(dir, `foreman-${id}.raw.txt`), raw, 'utf8')
    const m = raw.match(/<svg[\s\S]*?<\/svg>/i)
    finalAttempts.push({ id, ok: !!m, chars: raw.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null })
    if (m) { finalSvg = m[0]; used = id; break }
  } catch (e) {
    finalAttempts.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
  }
}
if (finalSvg) fs.writeFileSync(path.join(dir, 'final.svg'), finalSvg, 'utf8')
fs.writeFileSync(path.join(dir, 'plans.json'), JSON.stringify(plans, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
  task, budgets: { plansEach: 30000, foreman: 50000, reasoning: 'max' },
  startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
  plans, finalAttempts, foremanUsed: used, finalBytes: finalSvg.length,
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ dir, foreman: used, finalBytes: finalSvg.length, plans: plans.map((p) => ({ id: p.id, ok: p.ok, chars: p.chars, ms: p.ms, finishReason: p.finishReason })), finalAttempts: finalAttempts.map((x) => ({ id: x.id, ok: x.ok, chars: x.chars, ms: x.ms, finishReason: x.finishReason, error: x.error })), durationMs: Date.now() - started }, null, 2))
