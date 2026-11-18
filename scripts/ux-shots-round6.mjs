#!/usr/bin/env node
// Round 6 (2026-11-10) visual evidence: drive the real Electron window over the
// DevTools protocol, create knowledge cards through the real API, and capture
// each reworked surface. Test cards are deleted before the script exits.
import fs from 'node:fs/promises'
import path from 'node:path'

const port = process.argv[2] || '9444'
const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'panel-screenshots', 'ui-round-20261110')
await fs.mkdir(outDir, { recursive: true })

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
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || ''))
  return msg.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  const msg = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const file = path.join(outDir, name + '.png')
  await fs.writeFile(file, Buffer.from(msg.result.data, 'base64'))
  console.log('shot', file)
  return file
}

const samples = [
  { title: '输出目录约定', text: '所有构建产物放 dataRoot/runs，不写 C 盘；测试临时文件必须带时间戳并在结束时删除。', tags: ['项目', '路径', '约定'], kind: 'decision', status: 'approved', core: true },
  { title: '界面文案偏好', text: '每个页面第一屏要能回答“这是什么、能做什么、下一步点哪里”；空状态必须给出下一步入口。', tags: ['界面', '偏好'], kind: 'knowledge', status: 'approved', core: false },
  { title: '插件管理边界', text: '官方插件只能启停，第三方插件可以卸载；插件管理和投稿是两个独立入口。', tags: ['插件', '权限'], kind: 'decision', status: 'pending', core: false },
  { title: '被拒绝的示例', text: '这条用于验证“已拒绝”状态仍然可见、可以删除或重新通过。', tags: ['验收'], kind: 'note', status: 'rejected', core: false },
]

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await send('Page.reload', { ignoreCache: true })
  await wait(2600)

  await evaluate(`(async()=>{
    const tags=['UI 证据卡'];
    const existing=await fetch('/api/memory').then(r=>r.json());
    for(const e of existing.entries||[])if(e.title==='输出目录约定'||e.title==='界面文案偏好'||e.title==='插件管理边界'||e.title==='被拒绝的示例')
      await fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:e.id})});
    return true;
  })()`)
  for (const row of samples) {
    await evaluate(`fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ ...row, source: 'owner' })})}).then(r=>r.json())`)
  }

  await evaluate(`(async()=>{setView('memory');await loadMemory();return true})()`)
  await wait(500)
  await shot('memory-cards')

  await evaluate(`(()=>{document.getElementById('memoryNewToggle').click();return true})()`)
  await wait(350)
  await shot('memory-editor')
  await evaluate(`(()=>{document.getElementById('memoryAddClose').click();return true})()`)

  await evaluate(`(()=>{document.querySelector('[data-memory-tab="pending"]').click();return true})()`)
  await wait(350)
  await shot('memory-pending')
  await evaluate(`(()=>{document.querySelector('[data-memory-tab="all"]').click();return true})()`)

  await evaluate(`(async()=>{setView('plugins');for(let i=0;i<60&&!pluginCatalog;i++)await new Promise(r=>setTimeout(r,200));document.querySelector('[data-plugin-source="official"]').click();return true})()`)
  await wait(500)
  await shot('plugins-official')

  await evaluate(`(()=>{document.getElementById('pluginManage').click();return true})()`)
  await wait(350)
  await shot('plugin-admin')
  await evaluate(`(()=>{document.getElementById('pluginAdminClose').click();return true})()`)

  await evaluate(`(()=>{document.getElementById('pluginSubmit').click();return true})()`)
  await wait(350)
  await shot('plugin-submit')
  await evaluate(`(()=>{document.getElementById('pluginSubmitClose').click();return true})()`)

  await evaluate(`(()=>{document.querySelector('[data-plugin-source="all"]').click();setView('settings');showSettingsSection('secSession');return true})()`)
  await wait(500)
  await shot('settings-session')

  await evaluate(`(async()=>{setView('meeting');document.getElementById('toolPaletteBtn').click();setTimeout(()=>{const t=document.querySelector('[data-tool-tab="files"]');if(t)t.click()},300);return true})()`)
  await wait(700)
  await shot('tools-split-files')
  await evaluate(`(()=>{if(document.body.classList.contains('tool-split'))document.getElementById('toolDockClose').click();return true})()`)

  await evaluate(`(async()=>{
    const r=await fetch('/api/memory').then(x=>x.json());
    for(const e of r.entries||[])if(e.title==='输出目录约定'||e.title==='界面文案偏好'||e.title==='插件管理边界'||e.title==='被拒绝的示例')
      await fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:e.id})});
    await loadMemory();
    return true;
  })()`)
  await send('Emulation.clearDeviceMetricsOverride')
  console.log('DONE')
} catch (error) {
  console.error('FAIL round6 shots: ' + (error?.message || error))
  process.exitCode = 1
} finally {
  ws.close()
}
