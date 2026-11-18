// Round-4 E2E: the background-failure path after 「放弃等待」.
// Zero token cost: only the two meeting endpoints are stubbed, no model is
// called and no files are written. Safe to run without API keys.
// Usage: node tests/e2e/round4-failure.mjs [debugPort]
import fs from 'node:fs'
import path from 'node:path'

const port = process.argv[2] || '9447'
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
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
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
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + String(detail).slice(0, 200) : ''))
}

// Stub only /api/meetings/start and /api/meetings/<id>. Everything else
// (config, roster, plugins, permissions) keeps using the real server.
const stubExpr = `
(() => {
  const orig = window.fetch.bind(window);
  window.__origFetch = orig;
  window.__failNow = false;
  const json = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200, headers: { 'content-type': 'application/json' }
  });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String((input && input.url) || '');
    if (url.indexOf('/api/meetings/start') >= 0) {
      return json({ ok: true, id: 'stub-failure-run' }, 202);
    }
    if (url.indexOf('/api/meetings/stub-failure-run') >= 0) {
      if (window.__failNow) {
        const ids = typeof selectedIds === 'function' ? selectedIds() : [];
        return json({
          status: 'failed',
          error: 'only 1 proposals succeeded; need 2',
          errorStage: 'proposal',
          errorAgent: String(ids[1] || ids[0] || ''),
          errorAgents: ids,
        });
      }
      return json({
        status: 'running', startedAt: new Date().toISOString(), phase: '独立提案',
        progress: [{ phase: '独立提案', done: 1, total: 2 }], interjections: [],
      });
    }
    return orig(input, init);
  };
  return true;
})()`
await evaluate(stubExpr)
check('失败态桩已注入（未调用真实模型）', true)

try {
  await evaluate(`setView('meeting'); openNewMeetingModal('验收失败态：这条任务不会调用真实模型。'); document.querySelector('#nmStart').click();`)
  let card = false
  for (let i = 0; i < 12; i++) {
    await sleep(400)
    card = await evaluate(`!!document.querySelector('.meeting-progress')`)
    if (card) break
  }
  check('进度卡在桩会议中出现', card)

  await evaluate(`document.querySelector('.meeting-progress .mp-foot button').click()`)
  const abandoned = await evaluate(`({ running: state.running, pill: document.querySelector('#statusPill').textContent })`)
  check('放弃等待后界面解锁', abandoned.running === false && abandoned.pill.includes('已停止等待'), JSON.stringify(abandoned))

  await evaluate(`window.__failNow = true`)
  let outcome = null
  for (let i = 0; i < 14; i++) {
    await sleep(600)
    outcome = await evaluate(`(() => {
      const notice = [...document.querySelectorAll('#messages .notice')].find(n => n.textContent.indexOf('这场会议没能完成') >= 0);
      return {
        pill: document.querySelector('#statusPill').textContent,
        text: notice ? notice.textContent : '',
        retry: !!(notice && notice.querySelector('#bgMeetingRetry')),
        roster: !!(notice && notice.querySelector('#bgMeetingRoster')),
        running: state.running,
      };
    })()`)
    if (outcome.text) break
  }
  check('后台失败有中文说明，不再只塞英文内部错误',
    outcome.text.includes('这场会议没能完成') && outcome.pill.includes('后台会议未完成'), JSON.stringify(outcome))
  check('点名失败阶段与失败模型',
    outcome.text.includes('阶段：独立提案') && outcome.text.includes('模型：') && !outcome.text.includes('模型：未定位'), outcome.text.slice(0, 200))
  check('给出重试与换模型两个真实入口', outcome.retry && outcome.roster && outcome.running === false, JSON.stringify({ retry: outcome.retry, roster: outcome.roster, running: outcome.running }))
  await shot('round4-background-failure.png')

  const opened = await evaluate(`(() => {
    const b = document.querySelector('#bgMeetingRoster');
    if (!b) return false;
    b.click();
    return !!document.querySelector('.model-panel.open');
  })()`)
  check('「换模型再试」真的打开模型选择器', opened)
  await evaluate(`document.querySelector('#modelClose')?.click()`)
} finally {
  await evaluate(`(() => { if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch; delete window.__failNow; } return true })()`)
}

ws.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) {
  for (const f of failed) console.log('FAILED: ' + f.name + ' · ' + f.detail)
  process.exit(1)
}
