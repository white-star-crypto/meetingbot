import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'

const out = path.resolve('runs-app-review-v2')
const root = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(path.join(out, 'memos'), { recursive: true })
const config = loadConfig('meeting.config.local.json', { requireKeys: true })
const ids = ['ds-flash', 'glm-flash', 'mimo-flash', 'qwen-flash', 'wenxin-51', 'doubao-turbo', 'minimax-flash']
const snapshot = fs.readFileSync(path.resolve('briefs/self-review-grounded.md'), 'utf8')
const task = `请站在真实用户和人类工效学视角，评审 MeetingBot 这个桌面应用。

开发初衷：
- 单一模型往往只擅长一个领域，审美、架构、安全各有偏差；
- 多模型管理麻烦，用户不想在多个网页/客户端之间来回切换；
- 希望把“开工前先开一次会”变成可复用流程：独立提案 → 交叉批判 → 多维投票 → 主 Bot 决策；
- 目标不是做万能 Agent，而是做设计评审/方案收敛工具。

评审重点：
1. 现在整个应用还有哪些值得升级的地方；
2. 增添哪些有人味、真正省步骤的功能；
3. 老 UI / 老功能如何优化，包括信息层级、布局排版、密度、字体、空/载入/错误/成功状态、无障碍；
4. 整体 UI 与审美方向，保持简约，不要改成花哨 AI 仪表盘；
5. 从源代码和路径出发，不要泛泛谈“加个 AI”。
6. 最多给 3 个必做项，并写可验收标准。

只输出 Markdown 评审备忘录，不要写代码。

应用路径：
${root}

只读快照：
${snapshot}`

const memos = []
await Promise.all(ids.map(async (id) => {
  const p = config.participants.find((x) => x.id === id)
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are a senior product designer and frontend architect. Be specific, humane, and critical.' },
      { role: 'user', content: task },
    ], { temperature: 0.75, maxTokens: 40000, timeoutMs: 900000 })
    const text = String(r.content || '').trim()
    fs.writeFileSync(path.join(out, 'memos', `${id}.md`), text, 'utf8')
    memos.push({ id, ok: !!text, chars: text.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null })
  } catch (e) {
    memos.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
  }
}))
memos.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
const memoText = memos.map((m) => `## ${m.id}\n${m.ok ? fs.readFileSync(path.join(out, 'memos', `${m.id}.md`), 'utf8') : `FAILED: ${m.error}`}`).join('\n\n')

let report = ''
const attempts = []
for (const id of ['minimax-flash', 'qwen-flash', 'glm-flash']) {
  const p = config.participants.find((x) => x.id === id)
  const t0 = Date.now()
  try {
    const r = await callChat({ ...p, reasoningEffort: 'max' }, [
      { role: 'system', content: 'You are the foreman. Synthesize the memos into one honest, concrete product review.' },
      { role: 'user', content: `你是主 Bot。下面是 7 位评审员的备忘录。请合成一份最终评审报告，必须包含：现状判断、5 个具体升级、3 个必做项（含验收标准）、老 UI/老功能优化、整体布局排版建议、明确不做什么、风险。基于真实代码路径和快照，不要空泛。只输出 Markdown。\n\n会议任务：\n${task}\n\n评审备忘录：\n${memoText}` },
    ], { temperature: 0.7, maxTokens: 60000, timeoutMs: 1500000 })
    const text = String(r.content || '').trim()
    fs.writeFileSync(path.join(out, `foreman-${id}.md`), text, 'utf8')
    attempts.push({ id, ok: !!text, chars: text.length, ms: Date.now() - t0, usage: r.usage || null, finishReason: r.finishReason || null })
    if (text) { report = text; break }
  } catch (e) {
    attempts.push({ id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 })
  }
}
if (report) fs.writeFileSync(path.join(out, 'report.md'), report, 'utf8')
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ budgets: { memos: 40000, foreman: 60000, reasoning: 'max' }, memos, attempts, reportBytes: report.length }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ out, memos: memos.map((m) => ({ id: m.id, ok: m.ok, chars: m.chars, ms: m.ms, finishReason: m.finishReason })), attempts: attempts.map((a) => ({ id: a.id, ok: a.ok, chars: a.chars, ms: a.ms, finishReason: a.finishReason, error: a.error })), reportBytes: report.length }, null, 2))
