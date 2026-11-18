// Round-4 E2E driver: drives the real Electron window over CDP.
// Usage: node tests/e2e/round4-e2e.mjs [debugPort]
import fs from 'node:fs'
import path from 'node:path'

const port = process.argv[2] || '9444'
const shotDir = path.resolve('panel-screenshots')
fs.mkdirSync(shotDir, { recursive: true })
// The panel version moves with package.json; hard-coding it is what made this
// check stale (it still asserted 2.1.0 after the build moved to 2.2.0).
const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'))

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
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
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
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + String(detail).slice(0, 160) : ''))
}

// ---- boot ----
await sleep(2500)
const booted = await evaluate(`(() => ({
  title: document.title,
  onboarding: !document.querySelector('#onboardingCard').hidden,
  welcome: !document.querySelector('#welcomeCard').hidden,
  version: document.querySelector('#appVersion').textContent,
  rosterChip: document.querySelector('#rosterChip').textContent.trim(),
  statusPill: document.querySelector('#statusPill').textContent,
}))()`)
check('面板启动：标题/版本/阵容 chip 就绪', booted.version.includes(pkg.version), JSON.stringify(booted))

// ---- UI checks that cost no tokens ----
// 1. hint auto-restore. The default hint is built from user-configurable
// shortcut labels, so capture it instead of hard-coding yesterday's wording.
const hintDefault = await evaluate(`document.querySelector('#hint').textContent`)
await evaluate(`setHint('临时提示测试')`)
const hintNow = await evaluate(`document.querySelector('#hint').textContent`)
// A background Electron window may throttle setTimeout slightly past 4 s.
// Poll for the restore instead of assuming a fixed delay.
let hintLater = hintNow
for (let i = 0; i < 16; i++) {
  await sleep(500)
  hintLater = await evaluate(`document.querySelector('#hint').textContent`)
  if (hintLater === hintDefault) break
}
check('提示行自动复位', hintNow === '临时提示测试' && hintLater === hintDefault, hintNow + ' -> ' + hintLater)

// 2. floating panel no longer buried under modal
await evaluate(`document.querySelector('#modelBtn').click()`)
const panelOpen = await evaluate(`!!document.querySelector('.model-panel.open')`)
await evaluate(`openNewMeetingModal()`)
const stateAfterModal = await evaluate(`({
  panelStillOpen: !!document.querySelector('.model-panel.open'),
  modalOpen: document.querySelector('#newMeetingModal').classList.contains('open'),
})`)
await evaluate(`closeNewMeetingModal()`)
check('新会议弹窗先关闭模型面板（不再被压住）', panelOpen && !stateAfterModal.panelStillOpen && stateAfterModal.modalOpen, JSON.stringify(stateAfterModal))

// 3. nmStart guard while a meeting is marked running
await evaluate(`state.running = true; openNewMeetingModal(''); document.querySelector('#nmStart').click();`)
const guardMsg = await evaluate(`document.querySelector('#nmStatus').textContent`)
await evaluate(`state.running = false; closeNewMeetingModal()`)
check('会议运行中发起第二场有明确反馈', guardMsg.includes('已有一场会议在等待结果'), guardMsg)

// 4. demo blocked while running
await evaluate(`state.running = true; demoMeeting()`)
await sleep(300)
const demoMsg = await evaluate(`document.querySelector('#statusPill').textContent`)
await evaluate(`state.running = false`)
check('真实会议期间示例演示被拦下并说明', demoMsg.includes('示例演示暂不可用'), demoMsg)

// 5. settings search + meta
await evaluate(`setView('settings')`)
const settingsOk = await evaluate(`(() => {
  const metas = document.querySelectorAll('.settings .setting-meta').length
  document.querySelector('#settingsSearch').value = '字号'
  filterSettings('字号')
  const visibleRows = [...document.querySelectorAll('.settings .row')].filter(r => !r.hidden).length
  document.querySelector('#settingsSearch').value = ''
  filterSettings('')
  showSettingsSection('secAppearance')
  return { metas, visibleRows }
})()`)
check('设置搜索与逐项说明', settingsOk.metas >= 25 && settingsOk.visibleRows >= 1 && settingsOk.visibleRows <= 4, JSON.stringify(settingsOk))

// 6. permission modal (high risk needs disclaimer)
await evaluate(`requestPermissionMode('self-review')`)
const permModal = await evaluate(`({
  open: document.querySelector('#permissionModal').classList.contains('open'),
  agreeDisabled: document.querySelector('#permissionAccept').disabled,
})`)
await evaluate(`closePermissionModal()`)
check('高风险权限必须勾免责才能开', permModal.open && permModal.agreeDisabled, JSON.stringify(permModal))

// ---- real meeting E2E ----
console.log('--- real meeting ---')
// Cache hits can finish a repeated brief in under a second, which makes the
// progress card unobservable. The E2E exists to watch a real run, so disable
// the model cache for this start only.
await evaluate(`(() => {
  if (window.__e2eNoCache) return 'already'
  window.__e2eNoCache = true
  const orig = window.fetch.bind(window)
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input.url
      if (url.endsWith('/api/meetings/start') && init && init.body) {
        const body = JSON.parse(init.body)
        body.noCache = true
        init = { ...init, body: JSON.stringify(body) }
      }
    } catch {}
    return orig(input, init)
  }
  return 'patched'
})()`)
const brief = '评审一个小的产品决策：本地工具「合议」第一次打开时，欢迎页应该先展示三步引导，还是直接进入工作台？请给出建议、主要风险和下一步。'
await evaluate(`openNewMeetingModal(${JSON.stringify(brief)})`)
await evaluate(`document.querySelector('#nmStart').click()`)
await sleep(4000)
const progress0 = await evaluate(`(() => {
  const card = document.querySelector('.meeting-progress')
  if (!card) return { found: false }
  return {
    found: true,
    head: card.querySelector('.mp-head b').textContent,
    elapsed: card.querySelector('.mp-elapsed').textContent,
    steps: [...card.querySelectorAll('.mp-steps li')].map(li => li.textContent + (li.className.includes('on') ? '[on]' : (li.className.includes('done') ? '[done]' : ''))),
    people: [...card.querySelectorAll('.mp-person')].map(el => el.textContent.trim() + ':' + el.dataset.status),
    abandonBtn: !!card.querySelector('.mp-foot button'),
  }
})()`)
check('进度卡出现：阶段/耗时/参与者状态/放弃按钮', progress0.found && progress0.abandonBtn && progress0.people.length >= 2 && progress0.people.some(p => /:(running|done)$/.test(p)), JSON.stringify(progress0))

await sleep(8000)
const progress1 = await evaluate(`(() => {
  const card = document.querySelector('.meeting-progress')
  return card ? { elapsed: card.querySelector('.mp-elapsed').textContent, on: (card.querySelector('.mp-steps li.on')||{}).textContent, pill: document.querySelector('#statusPill').textContent } : null
})()`)
check('进度卡在走：耗时增加、阶段点亮、状态栏同步', progress1 && /\d+s/.test(progress1.elapsed) && progress1.on, JSON.stringify(progress1))

// ---- abandon ----
await evaluate(`document.querySelector('.meeting-progress .mp-foot button').click()`)
const abandonState = await evaluate(`({
  cardGone: !document.querySelector('.meeting-progress'),
  notice: (document.querySelector('#messages .notice')||{}).textContent,
  pill: document.querySelector('#statusPill').textContent,
  composerMode: document.querySelector('#composerMode').textContent,
  running: state.running,
})`)
check('放弃等待：卡片换说明、界面解锁、措辞诚实', abandonState.cardGone && abandonState.notice.includes('已停止等待') && abandonState.notice.includes('后台') && abandonState.running === false && /输入任务/.test(abandonState.composerMode) && !/会议进行中/.test(abandonState.composerMode), JSON.stringify(abandonState))
await shot('round4-abandoned-light.png')

// ---- background outcome: success OR failure (real models do fail) ----
console.log('--- waiting for background outcome (up to 210s) ---')
let done = null
for (let i = 0; i < 70; i++) {
  await sleep(3000)
  done = await evaluate(`(() => ({
    pill: document.querySelector('#statusPill').textContent,
    dnav: !document.querySelector('#decisionNavBtn').hidden,
    sessions: typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions.filter(s => s.mode === 'meeting').slice(0, 3).map(s => s.title.slice(0, 24)) : [],
  }))()`)
  if (/后台会议(已完成|未完成|失败)/.test(done.pill)) break
}
const failedRun = done.pill.includes('未完成') || done.pill.includes('失败')
check('后台会议有明确结局（成功或失败）', done.pill.includes('已完成') || failedRun, JSON.stringify(done))

if (!failedRun) {
  check('后台会议完成：状态栏提示 + 决策书按钮', done.pill.includes('后台会议已完成') && done.dnav, JSON.stringify(done))
  // The panel is a classic (non-module) script: top-level let bindings live in
  // the global lexical environment, so window.lastMeetingResult is always
  // undefined. Reference the binding directly instead.
  const decisionView = await evaluate(`(() => {
    if (typeof lastMeetingResult === 'undefined' || !lastMeetingResult) return null
    renderDecisionPage(lastMeetingResult)
    return { title: document.querySelector('#title').textContent, kvs: [...document.querySelectorAll('#decisionPage .kv span')].map(s => s.textContent) }
  })()`)
  check('决策书页可从后台结果打开', decisionView && decisionView.kvs.includes('采纳') && decisionView.kvs.includes('风险'), JSON.stringify(decisionView))
} else {
  const failure = await evaluate(`(() => {
    const notice = [...document.querySelectorAll('#messages .notice')].find(n => n.textContent.includes('这场会议没能完成'))
    if (!notice) return null
    return {
      text: notice.textContent,
      retry: !!notice.querySelector('#bgMeetingRetry'),
      roster: !!notice.querySelector('#bgMeetingRoster'),
      pill: document.querySelector('#statusPill').textContent,
    }
  })()`)
  check('后台会议失败：中文说明 + 阶段/模型 + 重试/换模型入口',
    !!failure && failure.retry && failure.roster && failure.text.includes('阶段：') && failure.text.includes('模型：'),
    JSON.stringify(failure))
  await shot('round4-background-failure.png')
}

// ---- dark + narrow screenshots ----
await evaluate(`document.querySelector('#decisionBack')?.click(); setView('meeting')`)
await evaluate(`state.settings.theme='dark'; save(); applyTheme()`)
await shot('round4-meeting-dark-1280.png')
await evaluate(`state.settings.theme='light'; save(); applyTheme()`)
await shot('round4-meeting-light-1280.png')
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 620, deviceScaleFactor: 1, mobile: false })
await sleep(600)
const narrowOk = await evaluate(`(() => {
  const doc = document.documentElement
  const overflow = doc.scrollWidth > doc.clientWidth + 1
  return { overflow, sidebar: getComputedStyle(doc).getPropertyValue('--sidebar').trim() }
})()`)
check('960×620 无横向溢出', !narrowOk.overflow, JSON.stringify(narrowOk))
await shot('round4-meeting-light-960.png')
await evaluate(`state.settings.theme='dark'; save(); applyTheme()`)
await shot('round4-meeting-dark-960.png')
await send('Emulation.clearDeviceMetricsOverride', {})

// plugins + model panel screenshots (no tokens)
await evaluate(`setView('plugins')`)
// Idle prefetch may finish at any moment; wait for the cards to actually
// render, then let two frames settle before measuring line clamping.
for (let i = 0; i < 20; i++) {
  await sleep(300)
  const ready = await evaluate(`(() => ({ count: document.querySelector('#pluginCatalogCount').textContent, cards: document.querySelectorAll('.plugin-desc').length }))()`)
  if (ready.cards >= 18 && ready.count.includes('插件')) break
}
await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
const pluginsOk = await evaluate(`(() => ({
  count: document.querySelector('#pluginCatalogCount').textContent,
  // Clamping is max-height: 3 lines + overflow:hidden, plus clampLines()
  // trimming long copy to an ellipsis once the view is visible. Check both.
  clamped: [...document.querySelectorAll('.plugin-desc')].every(el => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 19.8;
    return cs.overflow === 'hidden' && el.clientHeight <= lh * 3 + 1 && el.scrollHeight <= el.clientHeight + 1;
  }),
  clipped: [...document.querySelectorAll('.plugin-desc')].filter(el => el.dataset.full && el.dataset.full.length > el.textContent.length).length,
  ellipsis: [...document.querySelectorAll('.plugin-desc')].filter(el => el.dataset.full && el.dataset.full.length > el.textContent.length).every(el => el.textContent.endsWith('…')),
  disclaimerVisible: !document.querySelector('.plugin-disclaimer').hidden,
}))()`)
check('插件市场：目录载入、三行裁剪与省略号、风险提示在', pluginsOk.count.includes('插件') && pluginsOk.clamped && pluginsOk.clipped > 0 && pluginsOk.ellipsis && pluginsOk.disclaimerVisible, JSON.stringify(pluginsOk))
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

ws.close()
const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) {
  for (const f of failed) console.log('FAILED: ' + f.name + ' · ' + f.detail)
  process.exit(1)
}
