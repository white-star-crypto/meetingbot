import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const root = path.resolve('creative/pelican')
const outDir = path.join(root, 'models-low')
fs.mkdirSync(outDir, { recursive: true })
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const ids = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']
const prompt = `简要思考，只输出一个完整、可独立打开的 SVG 文档；代码控制在 12k 字符内，优先保证完整合法，不要 Markdown 代码围栏，不要解释，不要 JSON。直接以 <svg 开头。

主题：绘制一个自行车骑着戴安全帽的鹈鹕沿海岸线骑行，包含海浪、沙滩、棕榈树，使用 SVG 并加入腿部 IK 动画、翅膀旋转和背景视差效果。

硬性要求：
- viewBox 为 0 0 1200 700，1200x700。
- 只使用 SVG + SMIL（<animate> / <animateTransform>），不能用 JS、外部图片、外部字体或网络资源。
- 鹈鹕要真的是鹈鹕：大喙、喉囊、戴安全帽；在骑自行车。
- 腿部要表现髋-膝-脚近似 IK 的踩踏动作；翅膀有旋转；背景海浪/棕榈/沙滩有不同速度的视差动画。
- 构图要完整：天空、海岸线、海浪、沙滩、棕榈树、自行车、鹈鹕。
- 视觉上要好看、有层次、有明确的色彩方案；不要只是几个圆和线。
- 输出必须是合法 XML，<svg> 开头，</svg> 结尾。`

const results = []
await Promise.all(ids.map(async (id) => {
  const participant = config.participants.find((p) => p.id === id)
  if (!participant) { results.push({ id, ok: false, error: 'missing' }); return }
  const started = Date.now()
  const creative = { ...participant, reasoningEffort: 'low' }
  try {
    const r = await callChat(creative, [
      { role: 'system', content: 'You are an expert SVG illustrator and motion designer. Return only valid SVG.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.7, maxTokens: 16384, timeoutMs: 600000 })
    const raw = String(r.content || '').trim()
    fs.writeFileSync(path.join(outDir, `${id}.raw.txt`), raw, 'utf8')
    const m = raw.match(/<svg[\s\S]*?<\/svg>/i)
    if (m) fs.writeFileSync(path.join(outDir, `${id}.svg`), m[0], 'utf8')
    results.push({ id, ok: !!m, chars: raw.length, ms: Date.now() - started, usage: r.usage || null, finishReason: r.finishReason || null })
  } catch (e) {
    fs.writeFileSync(path.join(outDir, `${id}.error.txt`), String(e?.stack || e), 'utf8')
    results.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - started })
  }
}))
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ prompt, results }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(results, null, 2))

