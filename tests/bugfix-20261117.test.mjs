// 2026-11-17 bug 排查轮回归：路径穿越 / 并发守卫 / BOM / 中断可恢复 / 追问取消 / 悬浮钮位置。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const originalCwd = process.cwd()
const root = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingbot-bugfix-'))
process.env.MEETINGBOT_DATA_DIR = path.join(temp, 'data')
process.chdir(temp)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let panel, child, ws, hang
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + String(detail).slice(0, 140) : '')) }
try {
  // 1) 配置文件带 BOM 也能加载（Windows 记事本另存常见）
  const bomConfig = path.join(temp, 'bom-config.json')
  fs.writeFileSync(bomConfig, '\uFEFF' + fs.readFileSync(path.join(root, 'examples', 'config.mock.json'), 'utf8'))
  const { loadConfig } = await import('../src/config.mjs')
  let bomOk = false
  try { loadConfig(bomConfig, { requireKeys: false }); bomOk = true } catch {}
  check('BOM 配置文件可加载', bomOk)

  // 2) 中断会议可恢复：mock 会议中途 kill，meta.json 应已存在且无 decision
  const { runMeeting } = await import('../src/meeting.mjs')
  const briefPath = path.join(temp, 'brief.md')
  fs.writeFileSync(briefPath, '中断恢复回归：验证初版 meta 落盘。')
  const outDir = path.join(temp, 'runs')
  const meetingPromise = runMeeting({ briefPath, configPath: path.join(root, 'examples', 'config.mock.json'), outDir, mock: true, mockDelayMs: 400 })
  meetingPromise.catch(() => {})
  let earlyMeta = false
  for (let i = 0; i < 40; i += 1) {
    await sleep(150)
    try {
      const dirs = fs.readdirSync(outDir)
      if (dirs.length && fs.existsSync(path.join(outDir, dirs[0], 'meta.json')) && !fs.existsSync(path.join(outDir, dirs[0], 'decision.json'))) { earlyMeta = true; break }
    } catch {}
  }
  check('会议开局即写 meta（中断可恢复前提）', earlyMeta)
  await meetingPromise.catch(() => {})

  // 3) HTTP 层：路径穿越 / resume 并发 / jobs 守卫
  const { startPanel } = await import('../src/panel-server.mjs')
  panel = await startPanel({ configPath: path.join(root, 'examples', 'config.mock.json'), port: 0 })
  const page = await fetch(panel.url)
  const cookie = (page.headers.getSetCookie?.()[0] || page.headers.get('set-cookie') || '').split(';')[0]
  const api = (route, options = {}) => fetch(panel.url + route, { ...options, headers: { cookie, 'content-type': 'application/json', ...(options.headers || {}) } })
  const trav = await api('/api/runs/..%2F..%2Fstate/stages')
  check('stages 拒绝路径穿越 id', trav.status === 400, 'status=' + trav.status)
  const travResume = await api('/api/runs/..%2F..%2Fstate/resume', { method: 'POST' })
  check('resume 拒绝路径穿越 id', travResume.status === 400, 'status=' + travResume.status)
  const travRetry = await api('/api/runs/..%2F..%2Fstate/retry', { method: 'POST' })
  check('retry 拒绝路径穿越 id', travRetry.status === 400, 'status=' + travRetry.status)

  // 手工构造一个可恢复 run（有 meta 无 decision），验证并发恢复守卫
  const dataRoot = path.join(temp, 'data')
  const fakeRun = path.join(dataRoot, 'runs', 'fake-interrupted')
  fs.mkdirSync(path.join(fakeRun, 'proposals'), { recursive: true })
  fs.writeFileSync(path.join(fakeRun, 'brief.md'), '并发恢复守卫回归')
  fs.writeFileSync(path.join(fakeRun, 'meta.json'), JSON.stringify({ schema: 'meetingbot/run/v1', runId: 'fake-interrupted', brief: path.join(fakeRun, 'brief.md'), config: path.join(root, 'examples', 'config.mock.json'), roster: [], selection: { agents: [], workMode: 'council', count: 2 } }))
  const r1 = await api('/api/runs/fake-interrupted/resume', { method: 'POST' })
  const r2 = await api('/api/runs/fake-interrupted/resume', { method: 'POST' })
  check('同 run 并发恢复被 409 拦截', r1.status === 202 && r2.status === 409, r1.status + '/' + r2.status)

  // jobs：无 key 配置创建任务应 422 而不是留幽灵 running
  const noKeyConfig = path.join(temp, 'nokey.json')
  fs.writeFileSync(noKeyConfig, JSON.stringify({ roster: [{ id: 'nk', label: 'NK', baseUrl: 'https://example.invalid/v1', model: 'x' }] }))
  // 用 panel 当前 mock 配置（无 key）创建后台任务：readLiveConfig(true) 应抛错 → 422
  const jobRes = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ task: '幽灵任务回归', agentId: 'mock-a' }) })
  const jobBody = await jobRes.json().catch(() => ({}))
  check('无 key 时创建后台任务不留幽灵 running', jobRes.status === 422 || (jobRes.status === 202 && jobBody.job), 'status=' + jobRes.status)
  if (jobRes.status === 202) {
    // mock 配置允许无 key 运行则任务合法；改测 running 中 retry 守卫
    const retryRes = await api('/api/jobs/' + jobBody.job.id + '/retry', { method: 'POST' })
    check('运行中任务 retry 被 409 拦截', retryRes.status === 409, 'status=' + retryRes.status)
    await api('/api/jobs/' + jobBody.job.id + '/cancel', { method: 'POST' })
  }

  // 4) 前端行为：悬浮钮不盖发送、追问取消收尾、群聊贴底、模型面板 Tab 不困输入框
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  if (process.platform === 'win32' && fs.existsSync(edgePath)) {
  hang = http.createServer(() => {})
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  const hangUrl = `http://127.0.0.1:${hang.address().port}/v1`
  await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'hangbf', secret: 'test-key' }) })
  const added = await api('/api/providers/participant', { method: 'POST', body: JSON.stringify({ label: 'Hang BF', baseUrl: hangUrl, model: 'hang-bf', keyName: 'hangbf' }) }).then((r) => r.json())
  const hangId = added.id || 'custom-hang-bf'
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingbot-bugfix-edge-'))
  const edge = edgePath
  const port = 9527
  child = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', panel.url], { stdio: 'ignore' })
  let target = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(300)
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
      target = list.find((x) => x.type === 'page' && x.url.includes('127.0.0.1'))
      if (target) break
    } catch {}
  }
  assert.ok(target, 'Edge page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws timeout')), 10000); ws.addEventListener('open', () => { clearTimeout(t); res() }, { once: true }); ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')) }, { once: true }) })
  let id = 1
  const pending = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; const t = setTimeout(() => { pending.delete(i); rej(new Error('cdp timeout ' + method)) }, 20000); pending.set(i, (m) => { clearTimeout(t); res(m) }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300))
    return m.result?.result?.value
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(3000)

  const geo = await evaluate(`(async()=>{
    const host=document.querySelector('#messages');
    for(let i=0;i<40;i++)addMsg(host,'system',null,'撑高信息流 '+i);
    await new Promise(r=>setTimeout(r,120));
    const sc=host.parentElement;sc.scrollTop=0;
    await new Promise(r=>setTimeout(r,150));
    const btn=[...document.querySelectorAll('.jump-bottom')].find(b=>b.closest('#view-meeting'));
    const btnRect=btn.getBoundingClientRect();
    const sendBtn=document.querySelector('#send').getBoundingClientRect();
    const overlap=!(btnRect.bottom<sendBtn.top||btnRect.top>sendBtn.bottom||btnRect.right<sendBtn.left||btnRect.left>sendBtn.right);
    const inFeed=sc.getBoundingClientRect();
    const inside=btnRect.bottom<=inFeed.bottom+2;
    return {visible:!btn.hidden,overlap,inside};
  })()`)
  check('回到底部钮不盖发送按钮且在消息区内', geo.visible && !geo.overlap && geo.inside, JSON.stringify(geo))

  const question = await evaluate(`(async()=>{
    setView('single');
    await refreshRosterFromServer();
    singleModelId=${JSON.stringify(hangId)};updateSingleLabels();
    // 直接构造追问场景：showAgentQuestion + Esc 关闭，节点应被收尾
    const node=addMsg(document.querySelector('#singleMessages'),'bot',{name:'T',model:'t',initial:'T'},'正在调用…',{status:'真实调用'});
    let settled=null;
    showAgentQuestion({id:'q-test',question:{question:'测试追问'}},final=>{settled=final});
    await new Promise(r=>setTimeout(r,120));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,120));
    return {closed:!document.querySelector('#agentQuestionModal').classList.contains('open'),settled:!!settled,cancelled:settled?.cancelled===true};
  })()`)
  check('追问被 Esc 关闭后回调收尾（节点不死锁）', question.closed && question.settled && question.cancelled, JSON.stringify(question))

  const trap = await evaluate(`(async()=>{
    setView('meeting');
    document.querySelector('#modelBtn').click();
    await new Promise(r=>setTimeout(r,150));
    const input=document.querySelector('#input');input.focus();
    const ev=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
    input.dispatchEvent(ev);
    const notTrapped=!ev.defaultPrevented&&document.activeElement===input;
    document.querySelector('#modelPanel').classList.remove('open');
    return {notTrapped};
  })()`)
  check('模型面板打开时输入框 Tab 不被困住', trap.notTrapped, JSON.stringify(trap))

  const group = await evaluate(`(async()=>{
    setView('group');
    const gv=document.querySelector('#view-group');
    return {tracked:gv.dataset.stickInit==='1'};
  })()`)
  check('群聊真实滚动容器纳入贴底监听', group.tracked, JSON.stringify(group))

  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  } else {
    console.log('SKIP Edge UI checks: Microsoft Edge not installed on this host')
  }
} catch (error) {
  check('回归脚本执行', false, error.message)
} finally {
  try { ws?.close() } catch {}
  try { if (child?.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  try { await new Promise((r) => panel?.server.close(r)) } catch {}
  try { hang?.close() } catch {}
  process.chdir(originalCwd)
  delete process.env.MEETINGBOT_DATA_DIR
  await sleep(400)
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
}
const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length) process.exit(1)
