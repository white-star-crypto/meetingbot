import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const dir = path.resolve('creative/pelican-collab')
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const ids = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']
const task = `绘制一个自行车骑着戴安全帽的鹈鹕（注意：是自行车骑在鹈鹕头上，不是鹈鹕骑自行车）沿海岸线骑行，包含海浪、沙滩、棕榈树，使用 SVG 并加入腿部 IK 动画、翅膀旋转、自行车脚踏和车轮运动、实打实的前行动画、背景视差效果。`
const plans = ids.map((id) => `### ${id}\n${fs.readFileSync(path.join(dir, 'plans', `${id}.md`), 'utf8')}`).join('\n\n')
const prompt = `你是主 Bot，要合成 7 位模型的构图建议，完成唯一一张动画 SVG。

原始任务：
${task}

必须遵守：
- 自行车稳稳骑在戴安全帽的鹈鹕头顶，不能画反。
- 动画必须有：鹈鹕双腿髋-膝-脚 IK 行走、翅膀扇动、自行车脚踏旋转、双轮旋转、主体实打实向左前进、海浪/棕榈/前景不同速度视差。
- 1200x700，只用 SVG + SMIL，不用外部资源。
- 保持代码紧凑：SVG 总长不超过 6500 字符；宁可简化装饰，也要完整闭合 </svg>。
- 只输出 SVG，不要 Markdown，不要解释。

七份建议：
${plans}`

const attempts = []
let final = ''
for (const id of ['glm-flash']) {
  const p = config.participants.find((x) => x.id === id)
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are the foreman. Output only a complete valid SVG. Keep it under 6500 characters.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.7, maxTokens: 8192, timeoutMs: 300000 })
    const raw = String(r.content || '').trim()
    fs.writeFileSync(path.join(dir, `foreman-compact-${id}.raw.txt`), raw, 'utf8')
    const m = raw.match(/<svg[\s\S]*?<\/svg>/i)
    attempts.push({ id, ok: !!m, chars: raw.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null })
    if (m) { final = m[0]; break }
  } catch (e) {
    attempts.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
  }
}
if (final) fs.writeFileSync(path.join(dir, 'final.svg'), final, 'utf8')
fs.writeFileSync(path.join(dir, 'final-attempts.json'), JSON.stringify({ task, attempts, finalBytes: final.length }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ finalBytes: final.length, attempts }, null, 2))

