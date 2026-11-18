#!/usr/bin/env node
// 2026-11-10 hierarchy / visual acceptance against the real Electron window.
// Drives the panel over CDP and asserts, at 1280x820 / 1024x768 / 600x700:
// one left axis, one primary per page, consistent status pill, no overflow,
// no truncated headings, correct sidebar order, and an uncut split top bar.
import fs from 'node:fs/promises'
import path from 'node:path'

const port = process.argv[2] || '9444'
const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'panel-screenshots', 'hierarchy-20261110')
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = async (name) => {
  const msg = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  await fs.writeFile(path.join(outDir, name + '.png'), Buffer.from(msg.result.data, 'base64'))
}

const geometry = `(()=>{
  const vis=(el)=>!!el&&el.offsetParent!==null&&getComputedStyle(el).visibility!=='hidden';
  const top=document.querySelector('.top');
  const topRect=top.getBoundingClientRect();
  const children=[...top.children].filter(vis).map(el=>{const r=el.getBoundingClientRect();return {id:el.id||el.className.split(' ')[0],left:r.left,right:r.right,top:r.top,bottom:r.bottom}});
  const overlap=(a,b)=>a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1;
  const pairs=[];for(let i=0;i<children.length;i++)for(let j=i+1;j<children.length;j++)if(overlap(children[i],children[j]))pairs.push(children[i].id+'/'+children[j].id);
  const title=document.getElementById('title');
  const pill=document.getElementById('statusPill');
  const view=document.querySelector('.view.active');
  const headings=[...(view?view.querySelectorAll('h2'):[])].filter(vis);
  const pageHead=headings[0]||null;
  const primaries=[...(view?view.querySelectorAll('.send'):[])].filter(el=>vis(el)&&!el.classList.contains('send-quiet')&&!el.closest('.modal'));
  const brand=document.querySelector('.brand');
  const sideItems=[...document.querySelectorAll('.side *')];
  const order=['#workspaceCommon','#chatList','#memoryEntry','#accountEntry'].map(s=>{const el=document.querySelector(s);return el?sideItems.indexOf(el):-1});
  const rail=document.querySelector('.memory-side');
  return {
    innerWidth,innerHeight,
    scrollWidth:document.documentElement.scrollWidth,
    bodyScrollWidth:document.body.scrollWidth,
    topbar:Math.round(topRect.height),topRight:Math.round(topRect.right),
    topChildrenRight:Math.max(...children.map(c=>Math.round(c.right))),
    overlaps:pairs,
    titleText:title.textContent.trim(),
    titleClipped:title.scrollWidth>title.clientWidth+1,
    pillText:vis(pill)?pill.textContent.trim():'(hidden)',
    pillHeight:vis(pill)?Math.round(pill.getBoundingClientRect().height):0,
    pageHead:pageHead?pageHead.textContent.trim():'',
    pageHeadLeft:pageHead?Math.round(pageHead.getBoundingClientRect().left):-1,
    titleLeft:Math.round(title.getBoundingClientRect().left),
    headingClipped:headings.some(h=>h.scrollWidth>h.clientWidth+1),
    primaryCount:primaries.length,
    primaryLabels:primaries.map(b=>b.textContent.trim()),
    sidebarOrder:order,
    hasFooterBar:!!document.querySelector('.side-foot'),
    versionInline:!!(brand&&brand.querySelector('b #appVersion')),
    sideScroll:getComputedStyle(document.querySelector('.side-scroll')).overflow,
    chatScroll:getComputedStyle(document.getElementById('chatList')).overflowY,
    contentWidth:view?Math.round(view.getBoundingClientRect().width):0,
    railWidth:rail&&vis(rail)?Math.round(rail.getBoundingClientRect().width):0,
    memoryCols:rail&&vis(rail)?getComputedStyle(document.querySelector('.memory-shell')).gridTemplateColumns:'',
    dockOpen:document.body.classList.contains('tool-split'),
    dockTop:document.body.classList.contains('tool-split')?Math.round(document.getElementById('view-tools').getBoundingClientRect().top):-1,
    dockLeft:document.body.classList.contains('tool-split')?Math.round(document.getElementById('view-tools').getBoundingClientRect().left):-1,
    composerOverflow:(()=>{const bar=document.querySelector('#view-meeting .composer-bar');return bar?bar.scrollWidth-bar.clientWidth:0})(),
    hero:document.getElementById('meetingHeroTitle')?.textContent.trim()||'',
    onboardingVisible:vis(document.getElementById('onboardingCard')),
    welcomeVisible:vis(document.getElementById('welcomeCard')),
    introOrder:(()=>{const w=document.getElementById('welcomeCard'),o=document.getElementById('onboardingCard');if(!w||!o)return 'missing';return (w.compareDocumentPosition(o)&Node.DOCUMENT_POSITION_FOLLOWING)?'welcome-first':'onboarding-first'})()
  };
})()`

const problems = []
const report = []
function check(label, condition, detail) {
  if (!condition) problems.push(label + ' -> ' + detail)
  report.push((condition ? 'PASS ' : 'FAIL ') + label + (detail ? ' · ' + detail : ''))
}
const PILL_STATES = ['就绪', '运行中', '已完成', '本机索引', '仅本机', '立即生效', '本地记录', '队列', '决策书', '本机']
const EXPECT = {
  council: '让多个模型先开一次会，再动手',
  division: '按能力域分工，各出一版再交叉审查',
  ondemand: '只叫最合适的模型，主责 + 审查兜底'
}
async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await wait(350)
}
async function showView(name) {
  await evaluate(`(async()=>{setView(${JSON.stringify(name)});await new Promise(r=>setTimeout(r,420));return true})()`)
  await wait(250)
}
async function setMode(mode) {
  await evaluate(`(async()=>{document.querySelector('.nav[data-work-mode="${mode}"]').click();await new Promise(r=>setTimeout(r,380));return true})()`)
  await wait(200)
}
function assertCommon(g, size, tag) {
  const at = `${size.label} ${tag}`
  check(`${at} 无横向滚动`, g.scrollWidth <= size.width + 1 && g.bodyScrollWidth <= size.width + 1, `doc=${g.scrollWidth} body=${g.bodyScrollWidth} / ${size.width}`)
  check(`${at} 顶栏无溢出`, g.topChildrenRight <= g.topRight + 2, `${g.topChildrenRight}/${g.topRight}`)
  check(`${at} 顶栏无重叠`, g.overlaps.length === 0, g.overlaps.join(','))
  check(`${at} 标题未截断`, !g.titleClipped, g.titleText)
  check(`${at} 页面标题未截断`, !g.headingClipped, g.pageHead)
  check(`${at} 页面只有一个实心主按钮`, g.primaryCount <= 1, g.primaryLabels.join(' / '))
  check(`${at} 状态胶囊形态一致`, g.pillText === '(hidden)' || PILL_STATES.includes(g.pillText), g.pillText)
  check(`${at} 侧栏顺序：工作区→最近会话→记忆→账号`, g.sidebarOrder.every((v) => v >= 0) && g.sidebarOrder.every((v, i) => i === 0 || v > g.sidebarOrder[i - 1]), g.sidebarOrder.join(','))
  check(`${at} 品牌版本紧挨名字`, g.versionInline, 'version outside brand b')
  check(`${at} 底部无版本横栏`, !g.hasFooterBar, 'has .side-foot')
  check(`${at} 主内容宽度可用`, g.contentWidth >= 320, `${g.contentWidth}px`)
}

const sizes = [
  { width: 1280, height: 820, label: '1280x820' },
  { width: 1024, height: 768, label: '1024x768' },
  { width: 600, height: 700, label: '600x700' }
]
try {
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  await wait(2600)

  for (const size of sizes) {
    await setViewport(size.width, size.height)
    const label = size.label
    // Three work modes: hero, title, pill must change together.
    for (const mode of ['council', 'division', 'ondemand']) {
      await setMode(mode)
      const g = await evaluate(geometry)
      await shot(`${label}-${mode}`)
      assertCommon(g, size, mode)
      const names = { council: '合议', division: '分工', ondemand: '点将' }
      check(`${label} ${mode} hero/标题/胶囊同步`, g.hero === EXPECT[mode] && g.titleText === names[mode] && (g.pillText === '(hidden)' || ['就绪', '运行中', '已完成'].includes(g.pillText)), `hero=${g.hero} title=${g.titleText} pill=${g.pillText}`)
      if (mode === 'council') {
        check(`${label} 合议 hero 常驻`, g.welcomeVisible && g.introOrder === 'welcome-first', `welcome=${g.welcomeVisible} order=${g.introOrder}`)
      } else check(`${label} ${mode} 只剩本模式 hero（无合议引导卡）`, !g.onboardingVisible && g.welcomeVisible, `onboarding=${g.onboardingVisible} welcome=${g.welcomeVisible}`)
    }
    const views = size.width >= 1280 ? ['single', 'compare', 'group', 'plugins', 'memory', 'settings'] : ['single', 'compare', 'group', 'plugins', 'memory', 'settings']
    for (const view of views) {
      await showView(view)
      const g = await evaluate(geometry)
      await shot(`${label}-${view}`)
      assertCommon(g, size, view)
      const head = { single: '单 Agent 私聊', compare: '同一问题，多个模型并排回答', group: '轻群聊 · 不投票', plugins: '插件市场', memory: '知识卡', settings: '设置' }[view]
      check(`${label} ${view} 页面标题正确`, g.pageHead.startsWith(head), g.pageHead)
      // Pages with an internal rail (memory / settings) cannot share the top-bar
      // x-axis by design; the three full-width pages must.
      const axisViews = ['plugins', 'group', 'compare']
      if (axisViews.includes(view) && size.width >= 900) check(`${label} ${view} 正文与顶栏标题同轴`, Math.abs(g.pageHeadLeft - g.titleLeft) <= 2, `head=${g.pageHeadLeft} title=${g.titleLeft}`)
      if (view === 'memory') {
        if (size.width >= 900) check(`${label} 记忆左轨宽度 ≥ 200`, g.railWidth >= 200, `${g.railWidth}px`)
        else check(`${label} 记忆单列`, /^[^ ]+$/.test(g.memoryCols.trim()), g.memoryCols)
      }
    }
    // Split: top bar must span main + dock and the composer footer must not overflow.
    await showView('meeting')
    await evaluate(`(async()=>{if(!document.body.classList.contains('tool-split'))document.getElementById('toolPaletteBtn').click();await new Promise(r=>setTimeout(r,500));return true})()`)
    await wait(350)
    const split = await evaluate(geometry)
    await shot(`${label}-split`)
    check(`${label} 分屏顶栏横跨到窗口右缘`, split.dockOpen && split.topChildrenRight <= split.topRight + 2 && split.topRight >= size.width - 2, `topRight=${split.topRight} children=${split.topChildrenRight}`)
    check(`${label} 分屏工具区在顶栏下方`, split.dockTop >= 58, `dockTop=${split.dockTop}`)
    check(`${label} 分屏左栏输入区不溢出`, split.composerOverflow <= 2, `${split.composerOverflow}px`)
    check(`${label} 分屏顶栏无重叠`, split.overlaps.length === 0, split.overlaps.join(','))
    await evaluate(`(async()=>{if(document.body.classList.contains('tool-split'))document.getElementById('toolDockClose').click();await new Promise(r=>setTimeout(r,300));return true})()`)
  }

  // Dark theme keeps the same hierarchy.
  await setViewport(1280, 820)
  await evaluate(`(async()=>{state.settings.theme='dark';applyTheme();setView('memory');await loadMemory();await new Promise(r=>setTimeout(r,400));return true})()`)
  await shot('1280x820-memory-dark')
  await evaluate(`(async()=>{state.settings.theme='system';applyTheme();setView('meeting');return true})()`)

  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), problems, report }, null, 2) + '\n')
  for (const line of report) console.log(line)
  console.log('\n' + (problems.length ? 'FAIL ' + problems.length + ' hierarchy checks' : 'PASS hierarchy verification (' + report.length + ' checks, 3 sizes)'))
  if (problems.length) process.exitCode = 1
} catch (error) {
  console.error('FAIL hierarchy verification: ' + (error?.message || error))
  process.exitCode = 1
} finally {
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
}
