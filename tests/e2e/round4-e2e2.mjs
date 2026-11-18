// Round-4 E2E part 2: post-meeting checks + screenshots + post-reload guard check.
// The real meeting already completed in the background in part 1; the window
// still holds its state.
import fs from 'node:fs'
import path from 'node:path'

const port = process.argv[2] || '9445'
const shotDir = path.resolve('panel-screenshots')
fs.mkdirSync(shotDir, { recursive: true })

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!target) throw new Error('no page target')
if (typeof WebSocket === 'undefined') {
  console.error('E2E requires Node.js >=22.4 (global WebSocket) or a Node runtime with WebSocket available.')
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
  }
})
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(result.result.exceptionDetails).slice(0, 300))
  return result.result?.result?.value
}
async function shot(name) {
  await send('Page.enable', {})
  const data = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(data.result?.data || '', 'base64'))
  console.log('SHOT ' + name)
}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + String(detail).slice(0, 200) : ''))
}

// ---- decision page from the background result ----
const decisionView = await evaluate(`(() => {
  if (typeof lastMeetingResult === 'undefined' || !lastMeetingResult) return null
  renderDecisionPage(lastMeetingResult)
  return { title: document.querySelector('#title').textContent, kvs: [...document.querySelectorAll('#decisionPage .kv span')].map(s => s.textContent), usage: !!document.querySelector('#decisionPage') }
})()`)
check('决策书页可从后台结果打开', !!decisionView && decisionView.kvs.includes('采纳') && decisionView.kvs.includes('风险'), JSON.stringify(decisionView && decisionView.kvs))
const sessionList = await evaluate(`typeof sessions !== 'undefined' ? sessions.filter(s => s.mode === 'meeting').slice(0, 3).map(s => s.title.slice(0, 30)) : []`)
check('后台会议已写入会话列表', sessionList.length > 0, JSON.stringify(sessionList))

await evaluate(`document.querySelector('#decisionBack') && document.querySelector('#decisionBack').click(); setView('meeting')`)

// ---- dark + narrow screenshots ----
await evaluate(`state.settings.theme='dark'; save(); applyTheme()`)
await shot('round4-meeting-dark-1280.png')
await evaluate(`state.settings.theme='light'; save(); applyTheme()`)
await shot('round4-meeting-light-1280.png')
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 620, deviceScaleFactor: 1, mobile: false })
await sleep(600)
const narrowOk = await evaluate(`(() => {
  const doc = document.documentElement
  return { overflow: doc.scrollWidth > doc.clientWidth + 1, sidebar: getComputedStyle(doc).getPropertyValue('--sidebar').trim() }
})()`)
check('960×620 无横向溢出', !narrowOk.overflow, JSON.stringify(narrowOk))
await shot('round4-meeting-light-960.png')
await evaluate(`state.settings.theme='dark'; save(); applyTheme()`)
await shot('round4-meeting-dark-960.png')
await send('Emulation.clearDeviceMetricsOverride', {})

// ---- plugins + model panel (no tokens) ----
await evaluate(`state.settings.theme='light'; save(); applyTheme(); setView('plugins')`)
await sleep(3500)
const pluginsOk = await evaluate(`(() => ({
  count: document.querySelector('#pluginCatalogCount').textContent,
  clamped: [...document.querySelectorAll('.plugin-desc')].every(el => el.scrollHeight <= el.clientHeight + 1),
  disclaimerVisible: !document.querySelector('.plugin-disclaimer').hidden,
}))()`)
check('插件市场：目录载入、卡片钳制、风险提示在', pluginsOk.count.includes('插件') && pluginsOk.clamped && pluginsOk.disclaimerVisible, JSON.stringify(pluginsOk))
await shot('round4-plugins-light.png')

await evaluate(`setView('meeting'); document.querySelector('#modelBtn').click()`)
await sleep(500)
const modelPanelOk = await evaluate(`(() => {
  const panel = document.querySelector('.model-panel')
  const composer = document.querySelector('#view-meeting.active .composer')
  const pr = panel.getBoundingClientRect(), cr = composer.getBoundingClientRect()
  return { open: panel.classList.contains('open'), overlap: pr.bottom > cr.top + 2 }
})()`)
check('模型面板不压输入框（复验）', modelPanelOk.open && !modelPanelOk.overlap, JSON.stringify(modelPanelOk))
await shot('round4-model-panel-light.png')
await evaluate(`document.querySelector('#modelClose').click()`)

// ---- reload to pick up the nmStart reorder, then verify the guard ----
await send('Page.reload', {})
await sleep(3500)
const guard = await evaluate(`(() => {
  state.running = true
  openNewMeetingModal('测试需求：验证运行中的反馈')
  document.querySelector('#nmStart').click()
  const msg = document.querySelector('#nmStatus').textContent
  state.running = false
  closeNewMeetingModal()
  return msg
})()`)
check('会议运行中发起第二场有明确反馈（重载后）', guard.includes('已有一场会议在等待结果'), guard)

// single view + welcome (no tokens)
const singleOk = await evaluate(`(() => {
  setView('single')
  return { welcome: !document.querySelector('#singleWelcome').hidden, label: document.querySelector('#singleModelLabel').textContent, chip: document.querySelector('#contextChip').textContent }
})()`)
check('私聊视图可用（欢迎卡/模型/上下文 chip）', singleOk.welcome && singleOk.label.length > 0, JSON.stringify(singleOk))

ws.close()
const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) {
  for (const f of failed) console.log('FAILED: ' + f.name)
  process.exit(1)
}
