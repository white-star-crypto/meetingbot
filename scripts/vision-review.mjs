import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const imagePath = process.argv[2] || path.resolve('docs/screenshots/home.png')
const out = path.resolve('runs-vision-review')
fs.mkdirSync(out, { recursive: true })
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const b64 = fs.readFileSync(imagePath).toString('base64')
const prompt = `你是 MeetingBot 的多模态 UI 审核员。看这张桌面应用截图，按下面的产品意图判断它是否达到“简约、像人类产品、多模型评审工具”的预期。

产品意图：
- 多模型独立提案、批判、投票、主 Bot 决策；
- 用户需要快速管理多个模型的档位；
- 左侧导航、无边框窗口、简约主题；
- 不能像花哨 AI 仪表盘。

请严格输出 JSON（不要 Markdown）：
{
  "pass": true/false,
  "score": 0-10,
  "firstImpression": "一句话",
  "issues": [{"area":"布局/字体/间距/模型管理/上下文轨/其他","severity":"high/medium/low","problem":"具体问题","fix":"具体改法"}],
  "mustFix": ["最多3条"],
  "keep": ["最多3条"]
}
如果截图看不清或不是 MeetingBot，直接把 pass 设为 false 并说明。`

const ids = ['doubao-turbo', 'qwen-flash']
const attempts = []
let result = null
for (const id of ids) {
  const p = config.participants.find((x) => x.id === id)
  if (!p) continue
  try {
    const r = await callChat({ ...p, reasoningEffort: 'low' }, [
      { role: 'system', content: 'You are a strict visual UI reviewer. Return only JSON.' },
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ] },
    ], { temperature: 0.2, maxTokens: 8000, timeoutMs: 300000 })
    const text = String(r.content || '').trim()
    fs.writeFileSync(path.join(out, `vision-${id}.raw.txt`), text, 'utf8')
    let parsed = null
    const m = text.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
    attempts.push({ id, ok: !!parsed, chars: text.length, parsed, usage: r.usage || null })
    if (parsed) { result = { id, parsed }; break }
  } catch (e) {
    attempts.push({ id, ok: false, error: String(e?.message || e) })
  }
}
fs.writeFileSync(path.join(out, 'vision-result.json'), JSON.stringify({ imagePath, attempts, result }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ imagePath, result, attempts: attempts.map((a) => ({ id: a.id, ok: a.ok, chars: a.chars, error: a.error })) }, null, 2))
