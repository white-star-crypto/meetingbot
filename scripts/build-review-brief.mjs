import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(root, 'briefs', 'self-review-grounded.md')
const deny = new Set(['node_modules', 'runs', 'runs-live', 'runs-live2', 'runs-select', 'runs-select2', 'runs-self', 'runs-self2', 'runs-self-review', 'runs-v2', 'runs-v3', 'runs-v4', 'feedback', 'dist', 'release', 'build', '.git', 'state', 'backup', 'panel-screenshots', 'third_party', 'briefs', '_visual-qa', 'cloud', 'creative', 'smoke-data'])
const allowExt = new Set(['.mjs', '.cjs', '.js', '.json', '.md', '.html', '.css'])
const tree = []
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (deny.has(name) || name.startsWith('runs') || name.startsWith('release-')) continue
    const abs = path.join(dir, name)
    const st = fs.statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!allowExt.has(path.extname(name))) continue
    tree.push(path.relative(root, abs).replaceAll('\\', '/'))
  }
}
walk(root)
const files = [
  'public/panel.html',
  'electron/main.cjs',
  'src/panel-server.mjs',
  'src/meeting.mjs',
  'src/providers.mjs',
  'src/config.mjs',
  'meeting.config.local.json',
  'README.md',
  'docs/APP-SHELL.md',
  'docs/PRIOR-ART.md'
]
function linesOf(file) {
  const abs = path.join(root, file)
  if (!fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/)
}
function redact(text) {
  return String(text)
    .replace(/("(?:apiKey|api_key|key|token|secret|password)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
}
function excerpt(file, from, to, label = '') {
  const lines = linesOf(file)
  if (!lines) return `\n### ${file} — not present in this checkout\n`
  const start = Math.max(0, from - 1), end = Math.min(lines.length, to)
  return `\n### ${file}${label ? ' — ' + label : ''}\n\`\`\`${file.endsWith('.json') ? 'json' : file.endsWith('.md') ? 'md' : 'js'}\n` +
    redact(lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(4)} ${line}`).join('\n')) + '\n```\n'
}
const panel = linesOf('public/panel.html')
const pick = (file, re, before = 2, after = 8) => {
  const lines = linesOf(file)
  const idx = lines.findIndex((l) => re.test(l))
  if (idx < 0) return ''
  return excerpt(file, Math.max(1, idx - before), Math.min(lines.length, idx + after), String(re))
}
// panel: shell/CSS + key JS functions, not the whole 100k file
let body = ''
body += excerpt('public/panel.html', 1, 220, '全局变量 / 布局 / 组件样式')
body += pick('public/panel.html', /function initRail|function initModelPicker|function renderModelPicker|function testProvider|function setView|function decision|function demoMeeting|const modelGroups|const providerPresets/, 3, 45)
body += excerpt('electron/main.cjs', 1, 180, 'Electron 主进程')
body += excerpt('src/panel-server.mjs', 1, 150, '面板 API / provider test')
body += pick('src/meeting.mjs', /preset\?\.thinking|function runMeeting|async function runMeeting/, 3, 24)
body += pick('src/providers.mjs', /export async function callChat/, 2, 34)
body += excerpt('meeting.config.local.json', 1, 80, '本地配置（不含 key 值）')
body += excerpt('README.md', 1, 80, '产品说明')
body += excerpt('docs/APP-SHELL.md', 1, 80, '桌面壳决策')

const ROOT = process.cwd()

const brief = `# MeetingBot 自我优化评审（只读代码快照）

## 读取声明

这份上下文由 MeetingBot 的只读快照脚本从以下目录生成，模型不会执行文件写入，也不会运行仓库命令：

\`${ROOT}\`

只读权限对应 \`computerAccess.mode = read-only\`。以下内容来自实际文件；不是产品自述。

## 文件树（节选）

\`\`\`text
${tree.filter((f) => !f.startsWith('examples/')).join('\n')}
\`\`\`

## 实际代码与配置

${body}

## 任务

你是 MeetingBot 的外部设计/体验评审员。请基于上面的**真实代码快照**，不要复述我给的结论。

重点只放在：

1. 功能增加：哪些功能值得加，为什么；不要再堆“多模型”这种已经有的东西。
2. 旧功能优化：模型选择、设置、会议动线、上下文轨、状态反馈里，哪些是真正会让用户少走一步的改动。
3. UI 美化与布局排版：保持简约主题，不改掉无边框、左侧导航、纯白/纯黑/系统三主题；提升层次、密度、字体、留白、可读性和人味。
4. 只读能力：当前应用能读代码快照但不能写；评审不要把“只读”误当成可执行工具。
5. 优先级：最多给 3 个必做项，给可验收标准。
6. 诚实：指出当前代码里哪些地方会让用户误以为功能完成了，但实际没有接上。

约束：

- 不要输出代码补丁，不要假装已经运行应用。
- 不要建议加入 Kimi。
- 不要建议改简约主题方向。
- 不要给出“做个 AI 仪表盘”“加大量动画”这类与定位冲突的建议。
- 不要讨论密钥、成本、权限时不看实际代码；如果没有证据，说没有证据。

输出请包含：对现状的判断、5 个具体改动（按影响/成本排序）、3 个必做项、风险、你认为应该明确不做的 2 件事。
`
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, brief, 'utf8')
console.log(JSON.stringify({ output: out, bytes: Buffer.byteLength(brief), files: tree.length, excerpts: (body.match(/^### /gm) || []).length }))
