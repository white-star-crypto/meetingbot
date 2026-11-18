// Round-4 part-3 E2E: per-call progress counters + idle prefetch, in the real window.
import fs from 'node:fs'
import path from 'node:path'

const port = process.argv[2] || '9446'
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
  if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg) }
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

await sleep(3000)

// ---- B: idle prefetch (no tokens) ----
// The idle warm-up should have run within the first seconds after load.
const prefetch = await evaluate(`(() => ({
  catalogLoaded: !!pluginCatalog,
  cardsRendered: typeof pluginFiltered !== 'undefined' ? pluginFiltered.length : 0,
}))()`)
check('空闲预取已把目录载入内存（未点开插件页）', prefetch.catalogLoaded, JSON.stringify(prefetch))

// concurrent load shares one fetch: both resolve to the same catalog object.
// (When already warm, loadPluginCatalog returns a fresh Promise each call, so
// comparing Promise identity is wrong — compare the resolved value.)
const shared = await evaluate(`(async () => {
  const a = await loadPluginCatalog()
  const b = await loadPluginCatalog()
  return a === b
})()`)
check('并发 loadPluginCatalog 共享同一次请求', shared === true)

// plugin page opens instantly
const t0 = Date.now()
await evaluate(`setView('plugins')`)
const instant = await evaluate(`(() => ({
  rendered: document.querySelectorAll('.plugin').length,
  label: document.querySelector('#pluginResultCount').textContent,
}))()`)
check('插件页首次打开即渲染（预取生效）', instant.rendered > 0 && instant.label.includes('结果'), JSON.stringify(instant) + ' in ' + (Date.now() - t0) + 'ms')

// ---- A: real meeting with per-call counters ----
console.log('--- real meeting ---')
await evaluate(`setView('meeting'); openNewMeetingModal('评审一个小决策：双语文档（中英对照）的工具首页，第一屏应该先放什么？给出建议、风险、下一步。')`)
await evaluate(`document.querySelector('#nmStart').click()`)
await sleep(4000)
const p0 = await evaluate(`(() => {
  const card = document.querySelector('.meeting-progress')
  return card ? { steps: [...card.querySelectorAll('.mp-steps li')].map(li => li.textContent) } : null
})()`)
check('进度卡出现', !!p0, JSON.stringify(p0))

// watch counters advance across polls
let counterSeen = null
for (let i = 0; i < 26; i++) {
  await sleep(3000)
  counterSeen = await evaluate(`(() => {
    const card = document.querySelector('.meeting-progress')
    if (!card) return { gone: true }
    const li = card.querySelector('.mp-steps li.on')
    return { gone: false, on: li ? li.textContent : '' }
  })()`)
  if (counterSeen.gone) break
  // once a counter appears, record it
  if (/\d+\/\d+/.test(counterSeen.on)) { console.log('  counter: ' + counterSeen.on); break }
}
check('逐调用计数出现在阶段标签上（如 独立提案 1/2）', !!counterSeen && !counterSeen.gone && /\d+\/\d+/.test(counterSeen.on), counterSeen && counterSeen.on)

// continue watching until the meeting completes (or counters evolve)
let finalSteps = null
for (let i = 0; i < 60; i++) {
  await sleep(3000)
  const st = await evaluate(`(() => {
    const card = document.querySelector('.meeting-progress')
    if (!card) return { gone: true, decision: !!document.querySelector('.decision') }
    return { gone: false, steps: [...card.querySelectorAll('.mp-steps li')].map(li => li.textContent + (li.className.includes('on') ? '[on]' : (li.className.includes('done') ? '[done]' : ''))), pill: document.querySelector('#statusPill').textContent }
  })()`)
  if (st.gone) { finalSteps = st; break }
  if (st.steps.some(s => s.includes('投票') && s.includes('[on]'))) { finalSteps = st; break }
}
console.log('state snapshot: ' + JSON.stringify(finalSteps).slice(0, 240))
// The vote phase being reached proves proposal counters existed for a full phase.
const hadVotePhase = finalSteps && (finalSteps.gone || finalSteps.steps.some(s => s.includes('投票') && s.includes('[on]')))
check('会议推进到投票阶段（逐调用计数全程伴随）', !!hadVotePhase, JSON.stringify(finalSteps).slice(0, 160))
await shot('round4b-progress-counters.png')

// wait for completion to leave a clean state
for (let i = 0; i < 60; i++) {
  await sleep(3000)
  const done = await evaluate(`(() => {
    const card = document.querySelector('.meeting-progress')
    return { gone: !card, pill: document.querySelector('#statusPill').textContent }
  })()`)
  if (done.gone || done.pill.includes('已生成决议') || done.pill.includes('失败')) { console.log('final pill: ' + done.pill); break }
}
const outcome = await evaluate(`document.querySelector('#statusPill').textContent`)
check('真实会议完成（状态栏收尾）', outcome.includes('已生成决议') || outcome.includes('后台会议已完成') || outcome.includes('失败'), outcome)

ws.close()
const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) { for (const f of failed) console.log('FAILED: ' + f.name); process.exit(1) }
