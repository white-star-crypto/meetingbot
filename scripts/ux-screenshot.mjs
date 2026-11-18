#!/usr/bin/env node
// Real Electron window verification: reload the panel, drive it through three
// viewport sizes, capture PNG screenshots, and assert layout geometry at each
// size. Screenshots are written under panel-screenshots/visual-20261109/.
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const port = process.argv[2] || '9444'
const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'panel-screenshots', 'visual-20261109')
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
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function evaluate(expression) {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || ''))
  return msg.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const geometry = `(()=>{
  const ids=['backgroundJobsPill','permissionBadge','toolPaletteBtn','windowControls'];
  const boxes=ids.map(id=>{const el=document.getElementById(id);if(!el)return null;const r=el.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom}}).filter(Boolean);
  const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
  const pairs=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)if(overlap(boxes[i],boxes[j]))pairs.push(boxes[i].id+'/'+boxes[j].id);
  const cs=getComputedStyle(document.documentElement);
  const side=document.querySelector('.side');
  const dock=document.getElementById('view-tools');
  const topEl=document.querySelector('.top');
  const topRight=Math.round(topEl.getBoundingClientRect().right);
  const topChildrenRight=Math.max(...[...topEl.children].map(el=>Math.round(el.getBoundingClientRect().right)));
  const toolbar=document.getElementById('pluginSourceTabs')?.closest('.plugin-toolbar');
  // One row means the toolbar is about one control tall (<=44px). Counting
  // rounded top values misreads align-items:center by a few pixels.
  const toolbarHeight=toolbar?Math.round(toolbar.getBoundingClientRect().height):0;
  const search=document.getElementById('pluginSearch');
  const searchRow=search?.closest('.plugin-search-row');
  return {
    innerWidth,innerHeight,
    scrollWidth:document.documentElement.scrollWidth,
    bodyScrollWidth:document.body.scrollWidth,
    topbar:Math.round(topEl.getBoundingClientRect().height),
    topRight,topChildrenRight,
    sidebar:Math.round(side.getBoundingClientRect().width),
    sideScroll:getComputedStyle(document.querySelector('.side-scroll')).overflow,
    chatScroll:getComputedStyle(document.getElementById('chatList')).overflowY,
    dockWidth:document.body.classList.contains('tool-split')?Math.round(dock.getBoundingClientRect().width):0,
    dockTop:document.body.classList.contains('tool-split')?Math.round(dock.getBoundingClientRect().top):0,
    dockLeft:document.body.classList.contains('tool-split')?Math.round(dock.getBoundingClientRect().left):0,
    statusDisplay:getComputedStyle(document.getElementById('statusPill')).display,
    toolbarHeight,
    searchWidth:search?Math.round(search.getBoundingClientRect().width):0,
    searchRowWidth:searchRow?Math.round(searchRow.getBoundingClientRect().width):0,
    overlaps:pairs,
    bgBase:cs.getPropertyValue('--bg-base').trim(),
    accent:cs.getPropertyValue('--accent').trim(),
    textPrimary:cs.getPropertyValue('--text-primary').trim(),
    ruleCount:(()=>{try{return document.styleSheets[0].cssRules.length}catch{return -1}})()
  };
})()`

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await wait(420)
}
async function showView(name) {
  await evaluate(`(async()=>{
    setView('${name}');
    if('${name}'==='plugins'){for(let i=0;i<60&&!pluginCatalog;i++)await new Promise(r=>setTimeout(r,200));await new Promise(r=>setTimeout(r,250))}
    if('${name}'==='memory'){await loadMemory()}
    return true;
  })()`)
  await wait(320)
}
async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const buf = Buffer.from(msg.result.data, 'base64')
  await fs.writeFile(path.join(outDir, name), buf)
  return buf.length
}

const report = { port, generatedAt: new Date().toISOString(), cases: [] }
try {
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  // Wait for the reloaded document instead of polling a fixed timer.
  for (let i = 0; i < 40; i++) {
    await wait(200)
    const ready = await evaluate(`document.readyState==='complete'&&typeof setView==='function'`).catch(() => false)
    if (ready) break
  }
  await wait(700)

  const cases = [
    { w: 1280, h: 820, label: '1280x820', views: ['meeting', 'memory', 'plugins', 'tools'] },
    { w: 1024, h: 768, label: '1024x768', views: ['meeting', 'memory'] },
    { w: 600, h: 900, label: '600x900', views: ['meeting', 'memory'] },
  ]

  for (const c of cases) {
    await setViewport(c.w, c.h)
    const entry = { label: c.label, width: c.w, height: c.h, shots: [], geometry: null }
    for (const view of c.views) {
      if (view === 'tools') {
        await evaluate(`document.body.classList.remove('tool-split');document.getElementById('toolPaletteBtn').click();true`)
        await wait(400)
      } else {
        await evaluate(`(document.body.classList.contains('tool-split')?document.getElementById('toolDockClose').click():null);true`)
        await showView(view)
      }
      const file = `${c.label}-${view}.png`
      const bytes = await shot(file)
      const g = await evaluate(geometry)
      entry.geometry = g
      entry.shots.push({ view, file, bytes, scrollWidth: g.scrollWidth, overlaps: g.overlaps, dockWidth: g.dockWidth, toolbarHeight: g.toolbarHeight, topOverflow: g.topChildrenRight - g.topRight })
      console.log(`PASS ${c.label} ${view.padEnd(8)} ${String(bytes).padStart(7)} B  scroll=${g.scrollWidth}  overlaps=${g.overlaps.length}  dock=${g.dockWidth}  topRight=${g.topRight}/${g.topChildrenRight}`)
    }
    report.cases.push(entry)
  }

  // Extra evidence: the same workbench in the ink-blue dark theme, then
  // restore whatever theme the owner actually had.
  const originalTheme = await evaluate(`state.settings.theme`)
  await setViewport(1280, 820)
  await evaluate(`state.settings.theme='dark';applyTheme();setView('meeting');true`)
  await wait(420)
  const darkBytes = await shot('1280x820-meeting-dark.png')
  const darkGeo = await evaluate(geometry)
  report.dark = {
    file: '1280x820-meeting-dark.png', bytes: darkBytes,
    theme: await evaluate(`document.documentElement.dataset.theme`),
    bgBase: darkGeo.bgBase, accent: darkGeo.accent, scrollWidth: darkGeo.scrollWidth,
  }
  console.log(`PASS 1280x820 dark     ${String(darkBytes).padStart(7)} B  theme=${report.dark.theme} bg=${darkGeo.bgBase} accent=${darkGeo.accent}`)
  await evaluate(`state.settings.theme=${JSON.stringify(originalTheme)};applyTheme();true`)

  await evaluate(`(document.body.classList.contains('tool-split')?document.getElementById('toolDockClose').click():null);setView('meeting');true`)
  await send('Emulation.clearDeviceMetricsOverride')
  await wait(250)

  // Assertions across all captured sizes.
  const problems = []
  for (const entry of report.cases) {
    const g = entry.geometry
    if (g.scrollWidth > entry.width + 1) problems.push(`${entry.label}: horizontal overflow ${g.scrollWidth}>${entry.width}`)
    if (g.bodyScrollWidth > entry.width + 1) problems.push(`${entry.label}: body overflow ${g.bodyScrollWidth}`)
    if (g.overlaps.length) problems.push(`${entry.label}: topbar overlap ${g.overlaps.join(',')}`)
    if (g.sideScroll !== 'hidden') problems.push(`${entry.label}: sidebar scrolls (${g.sideScroll})`)
    if (g.chatScroll !== 'auto') problems.push(`${entry.label}: session list not independently scrollable`)
    if (g.topbar !== 58) problems.push(`${entry.label}: topbar is ${g.topbar}px`)
    if (!g.bgBase || !g.accent) problems.push(`${entry.label}: design tokens missing`)
    if (g.ruleCount < 100) problems.push(`${entry.label}: stylesheet did not parse (${g.ruleCount} rules)`)
  }
  const wide = report.cases[0]
  if (wide.geometry.sidebar < 248 || wide.geometry.sidebar > 264) problems.push(`1280 sidebar ${wide.geometry.sidebar}px outside 248-264`)
  const dockShot = wide.shots.find((s) => s.view === 'tools')
  if (!dockShot || Math.abs(dockShot.dockWidth - 640) > 4) problems.push(`tool dock is not half of 1280 (${dockShot?.dockWidth})`)
  for (const entry of report.cases) {
    for (const shot of entry.shots) {
      if (shot.topOverflow > 2) problems.push(`${entry.label}/${shot.view}: top bar overflows by ${shot.topOverflow}px`)
      if (shot.view === 'plugins' && shot.toolbarHeight > 44) problems.push(`${entry.label}: plugin toolbar is ${shot.toolbarHeight}px tall (want one row)`)
      if (shot.view === 'plugins' && entry.geometry.searchWidth < entry.geometry.searchRowWidth - 40) problems.push(`${entry.label}: plugin search is not full width`)
      if (shot.view === 'tools' && entry.geometry.dockTop < entry.geometry.topbar) problems.push(`${entry.label}: dock starts above the window-level top bar`)
    }
  }
  // 2026-11-10 hierarchy round: the status pill is the same object at every
  // size (it fits because the title and secondary chrome shrink).
  for (const entry of report.cases) {
    if (entry.geometry.statusDisplay === 'none') problems.push(`${entry.label}: status pill hidden`)
  }
  if (report.dark?.theme !== 'dark' || report.dark.bgBase !== '#111820') problems.push('dark theme tokens did not apply')

  report.problems = problems
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (problems.length) {
    console.log('\nFAIL geometry checks:')
    for (const p of problems) console.log('  - ' + p)
    process.exitCode = 1
  } else {
    console.log('\nPASS real-window screenshot verification (' + (report.cases.reduce((n, c) => n + c.shots.length, 0) + 1) + ' screenshots, 0 geometry problems)')
  }
} catch (error) {
  console.error('FAIL screenshot verification: ' + (error?.message || error))
  process.exitCode = 1
} finally {
  ws.close()
}
