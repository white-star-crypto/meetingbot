#!/usr/bin/env node
// Verifies the non-empty background-job pill and the settings entry for official
// plugin management. The job uses a deliberately unknown agentId: the runner
// rejects it before any model call, so this test never spends tokens.
import process from 'node:process'

const port = process.argv[2] || '9445'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!target) throw new Error('no page target on ' + port)
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
try {
  const expression = `(async()=>{
    const r=await fetch('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:'__ux_verify_unknown_agent__',task:'UI 验收：只验证胶囊计数，不调用任何模型'})});
    const data=await r.json().catch(()=>({}));
    await refreshJobsPill();
    const pillText=document.getElementById('backgroundJobsPill').textContent;
    const settingCount=document.getElementById('jobSettingsCount').textContent;
    document.getElementById('backgroundJobsPill').click();
    const menuRows=document.querySelectorAll('#backgroundJobsMenu [data-job-open]').length;
    const first=document.querySelector('#backgroundJobsMenu [data-job-open]');
    if(first)first.click();
    await new Promise(res=>setTimeout(res,500));
    const detailShown=!document.getElementById('jobDetail').hidden;
    const detailText=document.getElementById('jobDetail').textContent.slice(0,120);
    document.getElementById('officialPluginManage').click();
    const adminOpen=document.getElementById('pluginAdminModal').classList.contains('open');
    const submitOpen=document.getElementById('pluginSubmitModal').classList.contains('open');
    document.getElementById('pluginAdminClose').click();
    return {http:r.status,jobId:data.job?.id||'',pill:pillText,settingCount,menuRows,detailShown,detailText,adminOpen,submitOpen};
  })()`
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || ''))
  const v = msg.result?.result?.value
  if (v?.http !== 202 || !v.pill.includes('1 个后台任务') || v.settingCount !== '1 个' || v.menuRows < 1 || !v.detailShown || !v.adminOpen || v.submitOpen) {
    throw new Error('unexpected result: ' + JSON.stringify(v))
  }
  console.log('PASS background-job pill / detail / official plugin settings entry')
  console.log('  - POST /api/jobs -> ' + v.http + ' · ' + v.jobId)
  console.log('  - 胶囊「' + v.pill + '」· 设置「' + v.settingCount + '」· 菜单 ' + v.menuRows + ' 条')
  console.log('  - 点击任务进入详情: ' + v.detailShown + ' · ' + v.detailText.replace(/\s+/g, ' ').slice(0, 70))
  console.log('  - 设置「官方插件管理」打开管理弹窗: ' + v.adminOpen + ' · 投稿弹窗未打开: ' + !v.submitOpen)
} finally {
  ws.close()
}
