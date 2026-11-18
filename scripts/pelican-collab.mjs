import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const outDir = path.resolve('creative/pelican-collab')
fs.mkdirSync(path.join(outDir, 'plans'), { recursive: true })
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const ids = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']
const task = `绘制一个自行车骑着戴安全帽的鹈鹕（注意：是自行车骑在鹈鹕头上，不是鹈鹕骑自行车）沿海岸线骑行，包含海浪、沙滩、棕榈树，使用 SVG 并加入腿部 IK 动画、翅膀旋转、自行车脚踏和车轮运动、实打实的前行动画、背景视差效果。`

const planPrompt = `你是这次集体创作的一名构图/动画顾问。任务不是各画一张，而是所有人共同完成一张动画 SVG。

原始任务：
${task}

请只输出一份简短的构图与动画路线建议（不超过 1200 字）：
1. 画面主体怎么摆：自行车如何骑在鹈鹕头上；
2. 海岸、海浪、沙滩、棕榈的层次与前后关系；
3. 前行动画怎么做：主体位移、背景视差速度；
4. 翅膀扇动、腿部 IK、自行车脚踏/车轮的动画节奏；
5. 最容易画错的点，以及如何避免。
不要写 SVG，不要写代码，不要输出 JSON。`

const finalPrompt = `你是主 Bot。下面是 7 位模型对同一张动画 SVG 的构图建议。请采纳其中最好的部分，完成唯一一张最终作品。

原始任务：
${task}

强制要求：
- 画面必须是“自行车骑在戴安全帽的鹈鹕头上”，不能反过来。
- SVG 必须带动画：翅膀扇动、腿部 IK 踩踏/行走、自行车脚踏与车轮转动、主体实打实向前移动、背景至少两层不同速度的视差。
- 只输出一个完整合法 SVG，不要 Markdown，不要解释。
- 1200x700，不依赖外部图片/字体/JS。
- 预算充足，优先完整和好看，不要只画几个圆和线。

模型建议：
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
      { role: 'system', content: 'You are an expert art director for animated SVG scenes. Be concise and concrete.' },
      { role: 'user', content: planPrompt },
    ], { temperature: 0.8, maxTokens: 8192, timeoutMs: 600000 })
    const text = String(r.content || '').trim()
    fs.writeFileSync(path.join(outDir, 'plans', `${id}.md`), text, 'utf8')
    const rec = { id, ok: !!text, chars: text.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null }
    plans.push(rec); logs.push({ phase: 'plan', ...rec })
  } catch (e) {
    const rec = { id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 }
    plans.push(rec); logs.push({ phase: 'plan-error', ...rec })
  }
}))

// Deterministic order for the foreman prompt.
plans.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
const planText = plans.map((p) => `### ${p.id}\n${p.ok ? fs.readFileSync(path.join(outDir, 'plans', `${p.id}.md`), 'utf8') : `FAILED: ${p.error}`}`).join('\n\n')

// The app's foreman, with explicit fallback if a provider returns empty/truncated SVG.
const foremanOrder = ['minimax-flash', 'qwen-flash', 'glm-flash']
let finalSvg = ''
let used = ''
const finalAttempts = []
for (const id of foremanOrder) {
  const p = config.participants.find((x) => x.id === id)
  if (!p) continue
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are the elected foreman of a collaborative design meeting. Output only valid SVG.' },
      { role: 'user', content: finalPrompt + planText },
    ], { temperature: 0.75, maxTokens: 32768, timeoutMs: 900000 })
    const raw = String(r.content || '').trim()
    fs.writeFileSync(path.join(outDir, `foreman-${id}.raw.txt`), raw, 'utf8')
    const m = raw.match(/<svg[\s\S]*?<\/svg>/i)
    const rec = { id, ok: !!m, chars: raw.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null }
    finalAttempts.push(rec); logs.push({ phase: 'foreman', ...rec })
    if (m) { finalSvg = m[0]; used = id; break }
  } catch (e) {
    const rec = { id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 }
    finalAttempts.push(rec); logs.push({ phase: 'foreman-error', ...rec })
  }
}
if (finalSvg) fs.writeFileSync(path.join(outDir, 'final.svg'), finalSvg, 'utf8')
fs.writeFileSync(path.join(outDir, 'plans.json'), JSON.stringify(plans, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(outDir, 'collab-meta.json'), JSON.stringify({
  task, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
  models: ids, plans, foremanOrder, finalAttempts, foremanUsed: used,
  finalSvgBytes: finalSvg.length, logs,
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ outDir, foreman: used, plans: plans.map((p) => ({ id: p.id, ok: p.ok, chars: p.chars, ms: p.ms })), finalAttempts: finalAttempts.map((x) => ({ id: x.id, ok: x.ok, chars: x.chars, ms: x.ms, finishReason: x.finishReason })), durationMs: Date.now() - started }, null, 2))
