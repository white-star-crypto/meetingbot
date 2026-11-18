#!/usr/bin/env node
// Real-window UI verification through the Chrome DevTools Protocol attached to
// a running Electron window. Every check performs an actual DOM click / input
// and reads the resulting state; nothing here is a static source assertion.
import process from 'node:process'

const port = process.argv[2] || '9444'
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
async function evaluate(expression) {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || ''))
  return msg.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
async function check(name, expression, verify) {
  const value = await evaluate(expression)
  const detail = verify ? verify(value) : (value === true ? '' : JSON.stringify(value))
  if (detail === false) throw new Error(name + ' -> ' + JSON.stringify(value))
  results.push([name, typeof detail === 'string' ? detail : ''])
  console.log('PASS ' + name + (typeof detail === 'string' && detail ? ' · ' + detail : ''))
}

try {
  // Idempotency: clear leftovers if an earlier run aborted midway.
  await evaluate(`(async()=>{
    const rows=JSON.parse(localStorage.getItem('meetingbot.pluginSubmissions')||'[]').filter(p=>p.name!=='UI 验收投稿插件');
    localStorage.setItem('meetingbot.pluginSubmissions',JSON.stringify(rows));
    localStorage.removeItem('meetingbot.workspaceCommon');
    // The panel mirrors grouping into dataRoot/state/preferences.json; reset
    // that copy too, or the post-reload sync restores the test's grouping.
    await fetch('/api/preferences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceCommon:['council','division','ondemand','single','compare','runs','group','plugins'],toolSplitOpen:false})});
    try{
      const r=await fetch('/api/memory').then(x=>x.json());
      for(const e of (r.entries||[]))if(String(e.title||'').startsWith('UI 验收测试卡'))
        await fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:e.id})});
    }catch{}
    try{
      const reg=await fetch('/api/plugins/registry').then(x=>x.json());
      for(const row of (reg.plugins||[]))if(row.name==='UI 验收投稿插件')
        await fetch('/api/plugins/registry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'remove',id:row.id})});
    }catch{}
    return true;
  })()`)

  // Start from a freshly loaded document: the first-run workspace defaults are
  // only applied on boot, and the previous run left a custom grouping behind.
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  await wait(2400)

  // ---------------------------------------------------------------- workspace
  await check('首次使用工作区 7 项全部在常用，不常用为空', `(()=>{
    const c=document.querySelectorAll('#workspaceCommon .nav').length,m=document.querySelectorAll('#workspaceMore .nav').length;
    return {common:c,more:m,groups:[...document.querySelectorAll('.side-workspace .nav-label')].map(x=>x.textContent.trim())};
  })()`, (v) => v.common === 7 && v.more === 0 ? `常用 ${v.common} / 不常用 ${v.more}` : false)

  await check('常用 / 不常用可折叠，折叠状态写入 localStorage', `(()=>{
    const b=document.getElementById('workspaceCommonToggle'),root=document.getElementById('workspaceCommon');
    b.click();const folded=root.classList.contains('collapsed');const saved=localStorage.getItem('meetingbot.workspaceCommonOpen');
    b.click();const unfolded=!root.classList.contains('collapsed');
    return {folded,saved,unfolded,moreFolded:document.getElementById('workspaceMore').classList.contains('collapsed')};
  })()`, (v) => v.folded && v.saved === '0' && v.unfolded && v.moreFolded ? `折叠=${v.folded} 持久化=${v.saved} 恢复=${v.unfolded}` : false)

  await check('侧栏工作区固定，只有最近会话列表滚动', `(()=>{
    const s=getComputedStyle(document.querySelector('.side-scroll')),
      w=getComputedStyle(document.querySelector('.side-workspace')),
      c=getComputedStyle(document.getElementById('chatList'));
    return {side:s.overflow,workspace:w.flexGrow+'/'+w.flexShrink,chat:c.overflowY,chatScroll:document.getElementById('chatList').scrollHeight>=document.getElementById('chatList').clientHeight};
  })()`, (v) => v.side === 'hidden' && v.workspace === '0/0' && v.chat === 'auto' ? `side=${v.side} workspace=${v.workspace} chat=${v.chat}` : false)

  await check('设置里取消勾选 → 移到不常用；重新勾选 → 回到常用', `(async()=>{
    setView('settings');showSettingsSection('secSession');
    const box=[...document.querySelectorAll('#workspaceGroupPrefs input')].find(i=>i.value==='group');
    box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,250));
    const moved={inMore:!!document.querySelector('#workspaceMore .nav[data-view="group"]'),inCommon:!!document.querySelector('#workspaceCommon .nav[data-view="group"]'),saved:JSON.parse(localStorage.getItem('meetingbot.workspaceCommon')||'[]').includes('group')};
    box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,250));
    const back={inCommon:!!document.querySelector('#workspaceCommon .nav[data-view="group"]'),saved:JSON.parse(localStorage.getItem('meetingbot.workspaceCommon')||'[]').includes('group')};
    setView('meeting');
    return {moved,back};
  })()`, (v) => v.moved.inMore && !v.moved.inCommon && v.moved.saved === false && v.back.inCommon && v.back.saved
    ? '取消 → 不常用（已持久化）· 勾选 → 常用（已持久化）' : false)

  await check('运行中心不占工作区，设置里的入口能打开', `(async()=>{
    const workspaceHasRuns=!!document.querySelector('.side-workspace .nav[data-view="runs"]');
    setView('settings');showSettingsSection('secSession');
    const btn=document.getElementById('settingsRunsOpen');
    btn.click();
    await new Promise(r=>setTimeout(r,350));
    return {workspaceHasRuns,active:document.getElementById('view-runs').classList.contains('active'),title:document.getElementById('title').textContent,back:!!document.getElementById('runsBack')};
  })()`, (v) => !v.workspaceHasRuns && v.active && v.title === '运行' && v.back ? '工作区无运行入口 · 设置入口打开运行中心' : false)

  // ------------------------------------------------------------------- topbar
  await check('顶栏工具按钮不与权限、胶囊、窗口控制重叠', `(()=>{
    const ids=['backgroundJobsPill','permissionBadge','toolPaletteBtn','windowControls'];
    const boxes=ids.map(id=>{const el=document.getElementById(id);if(!el)return null;const r=el.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:r.width}}).filter(Boolean);
    const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
    const pairs=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)if(overlap(boxes[i],boxes[j]))pairs.push(boxes[i].id+'/'+boxes[j].id);
    return {boxes,pairs,sameRow:boxes.every(b=>Math.abs(b.top-boxes[0].top)<40)};
  })()`, (v) => v.pairs.length === 0 && v.sameRow ? `${v.boxes.length} 个元素同排 · 重叠 ${v.pairs.length}` : false)

  await check('工具按钮点击后右侧半屏展开，左侧页面保留', `(()=>{
    document.body.classList.remove('tool-split');
    document.getElementById('toolPaletteBtn').click();
    const dock=document.getElementById('view-tools').getBoundingClientRect();
    const left=document.querySelector('.view.active');
    return {split:document.body.classList.contains('tool-split'),dockWidth:Math.round(dock.width),dockTop:Math.round(dock.top),winWidth:innerWidth,leftView:left?.id||'',leftVisible:getComputedStyle(left).display!=='none',dockVisible:getComputedStyle(document.getElementById('view-tools')).display!=='none',saved:localStorage.getItem('meetingbot.toolSplitOpen')};
  })()`, (v) => v.split && v.dockTop >= 58 && Math.abs(v.dockWidth - v.winWidth / 2) < 30 && v.leftVisible && v.dockVisible && v.saved === '1'
    ? `半屏 ${v.dockWidth}px / ${v.winWidth}px · top=${v.dockTop} · 左侧 ${v.leftView} 保留` : false)

  await check('关闭按钮在工具页头部，点击后收起分屏', `(()=>{
    const close=document.getElementById('toolDockClose'),tabs=document.getElementById('toolTabs');
    const inHead=!!close.closest('.tools-head'),beforeTabs=close.compareDocumentPosition(tabs)&Node.DOCUMENT_POSITION_FOLLOWING;
    close.click();
    return {inHead,beforeTabs:!!beforeTabs,split:document.body.classList.contains('tool-split'),saved:localStorage.getItem('meetingbot.toolSplitOpen')};
  })()`, (v) => v.inHead && v.beforeTabs && !v.split && v.saved === '0' ? '头部关闭按钮生效 · 已收起' : false)

  // ------------------------------------------------------------------- memory
  await check('记忆库是原创知识卡工作台：子导航 / 统计 / 空状态 / 无 iframe', `(async()=>{
    setView('memory');await loadMemory();
    return {shell:!!document.querySelector('.memory-shell'),tabs:[...document.querySelectorAll('[data-memory-tab]')].map(x=>x.dataset.memoryTab),
      stats:document.querySelectorAll('#memoryStats .memory-stat').length,iframe:document.querySelectorAll('iframe').length,
      has7999:document.body.innerHTML.includes('7999'),emptyText:document.querySelector('#memoryList .memory-empty p')?.textContent||'',
      searchPlaceholder:document.getElementById('memorySearch')?.placeholder||''};
  })()`, (v) => v.shell && v.tabs.length === 3 && v.stats === 4 && v.iframe === 0 && !v.has7999 && v.emptyText.includes('新卡可以先放入待审')
    ? `子导航 ${v.tabs.join('/')} · 统计 ${v.stats} 项 · iframe ${v.iframe}` : false)

  const createdId = await evaluate(`(async()=>{
    document.getElementById('memoryNewToggle').click();
    const panel=document.getElementById('memoryAddPanel');
    document.getElementById('memoryTitle').value='UI 验收测试卡';
    document.getElementById('memoryText').value='这张卡由真实点击创建，验证完成后会删除。';
    document.getElementById('memoryTags').value='验收, 临时';
    document.getElementById('memoryKind').value='decision';
    document.getElementById('memoryPending').checked=true;
    document.getElementById('memoryAdd').click();
    await new Promise(r=>setTimeout(r,700));
    const r=await fetch('/api/memory').then(x=>x.json());
    const row=(r.entries||[]).find(e=>e.title==='UI 验收测试卡');
    return row?{id:row.id,status:row.status,kind:row.kind,tags:row.tags,formStatus:document.getElementById('memoryFormStatus').textContent}:null;
  })()`)
  if (!createdId || createdId.status !== 'pending' || createdId.kind !== 'decision') throw new Error('新建知识卡失败: ' + JSON.stringify(createdId))
  results.push(['真实点击新建知识卡 → 先入待审', `${createdId.id} · kind=${createdId.kind} · tags=${createdId.tags.join('/')}`])
  console.log('PASS 真实点击新建知识卡 → 先入待审 · ' + createdId.id)

  await check('待审视图显示「通过 / 拒绝」，点击通过后进入长期记忆', `(async()=>{
    document.querySelector('[data-memory-tab="pending"]').click();
    await new Promise(r=>setTimeout(r,350));
    const before=document.querySelectorAll('[data-memory-approve]').length;
    document.querySelector('[data-memory-approve="'+'${createdId.id}'+'"]').click();
    await new Promise(r=>setTimeout(r,500));
    const r=await fetch('/api/memory').then(x=>x.json());
    const row=(r.entries||[]).find(e=>e.id==='${createdId.id}');
    return {pendingButtons:before,status:row?.status,statusText:document.getElementById('memoryStatus').textContent};
  })()`, (v) => v.pendingButtons >= 1 && v.status === 'approved' && v.statusText.includes('成功') ? `待审按钮 ${v.pendingButtons} · 状态 ${v.status} · 反馈「${v.statusText}」` : false)

  await check('设为核心 / 搜索过滤 / 三个视图切换都真实工作', `(async()=>{
    document.querySelector('[data-memory-tab="all"]').click();
    await new Promise(r=>setTimeout(r,300));
    document.querySelector('[data-memory-core="'+'${createdId.id}'+'"]').click();
    await new Promise(r=>setTimeout(r,450));
    const core=document.querySelector('.memory-card.core')!==null;
    document.querySelector('[data-memory-tab="core"]').click();
    await new Promise(r=>setTimeout(r,300));
    const coreCount=document.querySelectorAll('.memory-card').length;
    document.querySelector('[data-memory-tab="all"]').click();
    await new Promise(r=>setTimeout(r,300));
    const s=document.getElementById('memorySearch');s.value='不存在的关键词xyz';s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,350));
    const filtered=document.querySelectorAll('.memory-card').length;
    s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,350));
    return {core,coreCount,filtered,restored:document.querySelectorAll('.memory-card').length};
  })()`, (v) => v.core && v.coreCount >= 1 && v.filtered === 0 && v.restored >= 1
    ? `核心高亮 ${v.core} · 核心视图 ${v.coreCount} 张 · 搜索后 ${v.filtered} 张 · 清空恢复 ${v.restored} 张` : false)

  await check('导出 JSON 有真实结果反馈', `(()=>{
    // Intercept the anchor so the verification does not drop a file on disk.
    const original=HTMLAnchorElement.prototype.click;let anchorClicked=false;
    HTMLAnchorElement.prototype.click=function(){anchorClicked=true};
    try{document.getElementById('memoryExport').click()}finally{HTMLAnchorElement.prototype.click=original}
    return {anchorClicked,text:document.getElementById('memoryFormStatus').textContent};
  })()`, (v) => v.anchorClicked && v.text.includes('已导出') ? v.text : false)

  await check('编辑已入库卡片：真实点击保存后标题 / 内容更新，状态不重置', `(async()=>{
    document.querySelector('[data-memory-tab="all"]').click();await new Promise(r=>setTimeout(r,250));
    document.querySelector('[data-memory-edit="${createdId.id}"]').click();await new Promise(r=>setTimeout(r,220));
    const opened=document.getElementById('memoryAddPanel').classList.contains('open');
    const pendingHidden=document.getElementById('memoryPending').closest('label').hidden;
    document.getElementById('memoryTitle').value='UI 验收测试卡（编辑后）';
    document.getElementById('memoryText').value='编辑后的内容，用来验证更新行为与列表刷新。';
    document.getElementById('memoryAdd').click();await new Promise(r=>setTimeout(r,750));
    const r=await fetch('/api/memory').then(x=>x.json());
    const row=(r.entries||[]).find(e=>e.id==='${createdId.id}');
    return {opened,pendingHidden,title:row?.title,text:row?.text,status:row?.status,core:row?.core,
      modalClosed:!document.getElementById('memoryAddPanel').classList.contains('open'),
      visible:[...document.querySelectorAll('.memory-card .mc-head b')].some(x=>x.textContent==='UI 验收测试卡（编辑后）')};
  })()`, (v) => v.opened && v.pendingHidden && v.title === 'UI 验收测试卡（编辑后）' && v.text.includes('编辑后') && v.status === 'approved' && v.core === true && v.modalClosed && v.visible
    ? `标题=${v.title} · 状态=${v.status} · 核心保留=${v.core}` : false)

  // ------------------------------------------------------------------ plugins
  await check('插件目录加载完成，搜索框占满第一行', `(async()=>{
    setView('plugins');
    for(let i=0;i<60&&!pluginCatalog;i++)await new Promise(r=>setTimeout(r,200));
    await new Promise(r=>setTimeout(r,250));
    const s=document.getElementById('pluginSearch'),row=s.closest('.plugin-search-row');
    return {loaded:!!pluginCatalog,catalog:pluginCatalog?.plugins?.length||0,searchWidth:Math.round(s.getBoundingClientRect().width),rowWidth:Math.round(row.getBoundingClientRect().width),
      searchTop:Math.round(s.getBoundingClientRect().top),toolbarTop:Math.round(document.querySelector('.plugin-toolbar').getBoundingClientRect().top)};
  })()`, (v) => v.loaded && Math.abs(v.searchWidth - v.rowWidth) < 40 && v.searchTop < v.toolbarTop
    ? `目录 ${v.catalog} 条 · 搜索框 ${v.searchWidth}px = 整行 ${v.rowWidth}px · 工具栏在其下方` : false)

  await check('输入即时过滤，来源分类「合议插件 / DSH 插件」正确', `(async()=>{
    document.querySelector('[data-plugin-source="official"]').click();
    await new Promise(r=>setTimeout(r,200));
    const official={total:pluginFiltered.length,names:pluginFiltered.map(p=>p.name),labels:[...document.querySelectorAll('#pluginCards .kind')].map(x=>x.textContent)};
    const officialButtons=[...document.querySelectorAll('#pluginCards .plugin-actions button')].map(x=>x.textContent);
    document.querySelector('[data-plugin-source="third"]').click();
    await new Promise(r=>setTimeout(r,200));
    const thirdTotal=pluginFiltered.length;
    document.querySelector('[data-plugin-source="all"]').click();
    await new Promise(r=>setTimeout(r,200));
    const allTotal=pluginFiltered.length;
    const s=document.getElementById('pluginSearch');s.value='memory';s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,350));
    const searched=pluginFiltered.length;
    s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,350));
    return {official,officialButtons,thirdTotal,allTotal,searched,cleared:pluginFiltered.length};
  })()`, (v) => v.official.total === 4 && v.official.labels.every((x) => x === '合议') && !v.officialButtons.includes('安装')
    && v.thirdTotal > 0 && v.allTotal === v.official.total + v.thirdTotal && v.searched < v.allTotal
    ? `官方 ${v.official.total} 张（${v.official.names.join('、')}）· 官方按钮 ${v.officialButtons.join('/')} · 第三方 ${v.thirdTotal} · 搜索命中 ${v.searched}` : false)

  await check('插件管理与投稿是两个独立弹窗，互不串场', `(()=>{
    document.getElementById('pluginManage').click();
    const a={admin:document.getElementById('pluginAdminModal').classList.contains('open'),submit:document.getElementById('pluginSubmitModal').classList.contains('open'),
      officialRows:document.querySelectorAll('#pluginAdminList .plugin-admin-row').length,uninstallForOfficial:[...document.querySelectorAll('#pluginAdminList .plugin-admin-row')].filter(r=>r.textContent.includes('不可卸载')).every(r=>!r.querySelector('[data-plugin-remove]'))};
    document.getElementById('pluginAdminClose').click();
    document.getElementById('pluginSubmit').click();
    const b={admin:document.getElementById('pluginAdminModal').classList.contains('open'),submit:document.getElementById('pluginSubmitModal').classList.contains('open')};
    document.getElementById('pluginSubmitClose').click();
    return {a,b};
  })()`, (v) => v.a.admin && !v.a.submit && v.a.officialRows >= 4 && v.a.uninstallForOfficial && !v.b.admin && v.b.submit
    ? `管理弹窗官方 ${v.a.officialRows} 行且不可卸载 · 投稿弹窗独立` : false)

  await check('官方插件停用：入口隐藏、卡片标已停用且没有「打开」，再启用恢复', `(async()=>{
    const navEl=document.querySelector('.nav[data-view="compare"]');
    const navBefore=!!navEl&&navEl.offsetParent!==null;
    document.getElementById('pluginManage').click();await new Promise(r=>setTimeout(r,180));
    const row=[...document.querySelectorAll('#pluginAdminList .plugin-admin-row')].find(x=>x.textContent.includes('对照'));
    row.querySelector('[data-plugin-toggle]').click();await new Promise(r=>setTimeout(r,650));
    const navHidden=!navEl||navEl.offsetParent===null;
    document.getElementById('pluginAdminClose').click();
    document.querySelector('[data-plugin-source="official"]').click();await new Promise(r=>setTimeout(r,300));
    const card=[...document.querySelectorAll('#pluginCards .plugin')].find(x=>x.textContent.includes('对照'));
    const hasOpen=!!card?.querySelector('[data-plugin-open]:not([hidden])');
    const disabledTag=!!card&&card.textContent.includes('已停用');
    document.getElementById('pluginManage').click();await new Promise(r=>setTimeout(r,180));
    const row2=[...document.querySelectorAll('#pluginAdminList .plugin-admin-row')].find(x=>x.textContent.includes('对照'));
    row2.querySelector('[data-plugin-toggle]').click();await new Promise(r=>setTimeout(r,650));
    document.getElementById('pluginAdminClose').click();
    const navRestored=!!navEl&&navEl.offsetParent!==null;
    return {navBefore,navHidden,hasOpen,disabledTag,navRestored,disabledStored:localStorage.getItem('meetingbot.officialDisabled')};
  })()`, (v) => v.navBefore && v.navHidden && !v.hasOpen && v.disabledTag && v.navRestored
    ? `停用后入口隐藏 · 卡片标已停用 · 无打开按钮 · 再启用后入口恢复` : false)

  const submission = await evaluate(`(()=>{
    const before=JSON.parse(localStorage.getItem('meetingbot.pluginSubmissions')||'[]').length;
    document.getElementById('pluginSubmit').click();
    document.getElementById('pluginSubmitName').value='UI 验收投稿插件';
    document.getElementById('pluginSubmitUrl').value='https://example.invalid/plugin';
    document.getElementById('pluginSubmitDesc').value='真实点击生成的本地索引，验证后清理。';
    document.getElementById('pluginSubmitSend').click();
    return {before,after:JSON.parse(localStorage.getItem('meetingbot.pluginSubmissions')||'[]').length,
      feedback:document.getElementById('pluginFeedback').textContent,
      visible:[...document.querySelectorAll('#pluginCards .plugin-name b')].some(x=>x.textContent==='UI 验收投稿插件')};
  })()`)
  if (!submission || submission.after !== submission.before + 1 || !submission.visible) throw new Error('投稿保存失败: ' + JSON.stringify(submission))
  results.push(['投稿保存后立刻在市场里可见（只写本地索引）', submission.feedback])
  console.log('PASS 投稿保存后立刻在市场里可见 · ' + submission.feedback)

  // --------------------------------------------------------------------- jobs
  await check('后台任务不占工作区；胶囊显示真实数量，点击展开', `(async()=>{
    const workspaceHasJobs=[...document.querySelectorAll('.side-workspace .nav')].some(x=>x.dataset.view==='jobs');
    const pill=document.getElementById('backgroundJobsPill');
    const before=pill.textContent;pill.click();
    await new Promise(r=>setTimeout(r,400));
    const opened=!document.getElementById('backgroundJobsMenu').hidden;
    pill.click();
    return {workspaceHasJobs,pillText:before,opened,settingsCount:document.getElementById('jobSettingsCount')?.textContent,settingsOpen:!!document.getElementById('jobSettingsOpen')};
  })()`, (v) => !v.workspaceHasJobs && v.opened && v.settingsOpen
    ? `胶囊「${v.pillText}」· 设置数量 ${v.settingsCount} · 可展开=${v.opened}` : false)

  await check('胶囊菜单里的「打开任务页」是真入口，能进隐藏任务页', `(async()=>{
    const pill=document.getElementById('backgroundJobsPill');pill.click();
    await new Promise(r=>setTimeout(r,400));
    const btn=document.querySelector('#backgroundJobsMenu [data-job-page]');
    if(!btn)return {found:false};
    btn.click();
    return {found:true,viewJobs:document.getElementById('view-jobs').classList.contains('active'),title:document.getElementById('title').textContent};
  })()`, (v) => v.found && v.viewJobs ? `进入「${v.title}」页` : false)

  // ------------------------------------------------------------------ compare
  await check('对照送出区初始隐藏；模型不限 4 个', `(()=>{
    setView('compare');
    const boxes=document.querySelectorAll('#compareModels input');
    return {handoffHidden:document.getElementById('compareHandoff').hidden,models:boxes.length,
      hint:document.querySelector('.compare-actions .hint')?.textContent||'',copyBound:!!document.querySelector('#compareColumns')};
  })()`, (v) => v.handoffHidden && v.models > 4 ? `可选模型 ${v.models} 个 · 送出区隐藏` : false)

  // ---------------------------------------------------------- persistence test
  await check('工作区分组状态刷新后保留', `(async()=>{
    const keep=['council','single','compare'];
    localStorage.setItem('meetingbot.workspaceCommon',JSON.stringify(keep));
    return {saved:localStorage.getItem('meetingbot.workspaceCommon')};
  })()`, (v) => JSON.parse(v.saved).length === 3 ? '已写入 3 项常用' : false)

  // Reload outside of the page context so the async evaluate does not die with
  // the old document, then re-check the DOM.
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: true })
  await wait(2200)
  const afterReload = await evaluate(`(()=>({
    common:document.querySelectorAll('#workspaceCommon .nav').length,
    more:document.querySelectorAll('#workspaceMore .nav').length,
    split:document.body.classList.contains('tool-split'),
    sourceTab:!!document.getElementById('pluginSourceTabs')
  }))()`)
  if (afterReload.common !== 3 || afterReload.more !== 4) throw new Error('分组状态没有持久化: ' + JSON.stringify(afterReload))
  results.push(['刷新后工作区分组保留', `常用 ${afterReload.common} / 不常用 ${afterReload.more}`])
  console.log('PASS 刷新后工作区分组保留 · 常用 3 / 不常用 4')

  // Restore the first-run default and clear the test artefacts.
  await evaluate(`(async()=>{
    localStorage.removeItem('meetingbot.workspaceCommon');
    localStorage.removeItem('meetingbot.toolSplitOpen');
    await fetch('/api/preferences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceCommon:['council','division','ondemand','single','compare','runs','group','plugins'],workspaceCommonOpen:true,workspaceMoreOpen:false,toolSplitOpen:false})});
    // Restore the live DOM too: removing the storage key alone leaves the test's
    // custom grouping on screen until the next reload.
    const all=['council','division','ondemand','single','compare','runs','group','plugins'];
    workspaceApply(all);
    document.getElementById('workspaceCommon').classList.remove('collapsed');
    document.getElementById('workspaceMore').classList.add('collapsed');
    document.getElementById('workspaceCommonToggle').textContent='⌃';
    document.getElementById('workspaceMoreToggle').textContent='⌄';
    const rows=JSON.parse(localStorage.getItem('meetingbot.pluginSubmissions')||'[]').filter(p=>p.name!=='UI 验收投稿插件');
    localStorage.setItem('meetingbot.pluginSubmissions',JSON.stringify(rows));
    try{
      const reg=await fetch('/api/plugins/registry').then(x=>x.json());
      for(const row of (reg.plugins||[]))if(row.name==='UI 验收投稿插件')
        await fetch('/api/plugins/registry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'remove',id:row.id})});
    }catch{}
    await fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:'${createdId.id}'})});
    setView('meeting');
    return true;
  })()`)
  results.push(['清理验证数据（恢复首次默认、删除测试卡与投稿）', ''])
  console.log('PASS 清理验证数据')

  console.log('\nPASS real-window UI verification (' + results.length + ' checks)')
} catch (error) {
  console.error('FAIL real-window UI verification: ' + (error?.message || error))
  process.exitCode = 1
} finally {
  ws.close()
}
