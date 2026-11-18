// Static UI wiring guard for the single-file panel.
//
// Behavioral coverage lives in tests/ui-contract.test.mjs (real panel server,
// HTTP auth, protected reads, SSRF route). This file remains deliberately
// static: it catches a dialog that is defined but never initialised, a setting
// that only lives in localStorage, or a broken failure chain cheaply.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const html = read('public/panel.html')
const server = read('src/panel-server.mjs')
const meeting = read('src/meeting.mjs')
const runner = read('src/agent-runner.mjs')
const config = read('src/config.mjs')
const main = read('electron/main.cjs')
const preload = read('electron/preload.cjs')
const sessionStore = read('src/session-store.mjs')
const memoryStore = read('src/memory-store.mjs')
const launcher = readFileSync(path.join(root, 'launch-app.ps1'), 'utf8')
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)][0][1]

const passed = []
function check(name, fn) {
  fn()
  passed.push(name)
}

check('前端脚本可编译（无语法错误）', () => {
  // Wrapping in an async function allows top-level await without executing anything.
  assert.doesNotThrow(() => new Function('return async function(){' + script + '\n}'))
})

check('启动流程真的初始化弹层与全局快捷键', () => {
  const boot = html.slice(html.lastIndexOf('(async()=>{'))
  assert.ok(boot.length > 100, '找不到启动 IIFE')
  assert.match(boot, /initUiDialog\(\);/)
  assert.match(boot, /initGlobalKeys\(\);/)
  assert.match(boot, /initNav\(\);/)
})

check('不再使用原生 prompt / confirm', () => {
  assert.doesNotMatch(html, /(?<![A-Za-z])(prompt|confirm)\s*\(/)
})

check('没有把 \\n 转义当文字显示给用户', () => {
  // A single \n is a real line break. Two backslashes before n would render
  // the characters "\n" on screen.
  assert.doesNotMatch(html, /\\\\n/)
})

check('每个设置行都有默认值、作用说明和真实读取点', () => {
  const defaults = html.match(/const SETTING_DEFAULTS=\{([\s\S]*?)\n\};/)[1]
  const meta = html.match(/const SETTING_META=\{([\s\S]*?)\n\};/)[1]
  const keys = [...new Set([...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]))]
  assert.ok(keys.length >= 25, '设置项数量异常：' + keys.length)
  for (const key of keys) {
    // permissionMode is owned by the backend, so it intentionally has no
    // localStorage default; every other key must have one.
    if (key !== 'permissionMode') {
      assert.ok(new RegExp('\\b' + key + '\\s*:').test(defaults), key + ' 缺少默认值')
    }
    assert.ok(new RegExp('\\b' + key + '\\s*:').test(meta), key + ' 缺少作用/生效方式说明')
    const refs = (html.match(new RegExp('\\b' + key + '\\b', 'g')) || []).length
    assert.ok(refs >= 3, key + ' 只有 UI 声明，没有真实读取点（refs=' + refs + '）')
  }
})

check('每个开关都有默认值并统一渲染', () => {
  const defaults = html.match(/const SETTING_DEFAULTS=\{([\s\S]*?)\n\};/)[1]
  const switches = [...new Set([...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]))]
  assert.ok(switches.length >= 10)
  for (const key of switches) assert.ok(new RegExp('\\b' + key + '\\s*:').test(defaults), key + ' 无默认值')
  assert.match(html, /\[data-setting\][\s\S]{0,200}classList\.toggle\('on'/)
})

check('六个设置分组与标签一一对应', () => {
  const tabs = [...html.matchAll(/data-jump="([^"]+)"/g)].map((m) => m[1])
  const sections = [...html.matchAll(/class="section" id="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(tabs.slice().sort(), sections.slice().sort())
  assert.equal(tabs.length, 6)
})

check('五个工作入口 + 工具入口都可达', () => {
  for (const v of ['single', 'compare', 'plugins', 'settings']) {
    assert.ok(html.includes('data-view="' + v + '"'), 'missing entry ' + v)
  }
  assert.ok(html.includes('id="view-runs"'), 'missing runs page')
  assert.ok(html.includes('id="settingsRunsOpen"'), 'missing runs settings entry')
  assert.ok(html.includes('id="memoryEntry"'), 'missing memory entry')
  assert.ok(html.includes('data-palette-view="tools"'), 'missing tools entry')
  assert.ok(html.includes('id="view-jobs"'), 'missing jobs page')
  for (const m of ['council', 'division', 'ondemand']) {
    assert.ok(html.includes('data-work-mode="' + m + '"'), '缺少工作模式 ' + m)
  }
})

check('会议启动守卫在弹窗前占位，不能并发开两场', () => {
  const start = html.indexOf('async function startLiveMeeting')
  const body = html.slice(start, start + 4000)
  assert.ok(start > 0)
  assert.ok(body.indexOf('state.running=true') >= 0)
  assert.ok(body.indexOf('state.running=true') < body.indexOf('await askMeetingExecutionIntent'), 'state.running 必须在 await 弹窗前占位')
})

check('会议失败 catch 必须复位 running，不能永久锁死入口', () => {
  const start = html.indexOf('async function startLiveMeeting')
  const end = html.indexOf('async function resumeLiveMeeting')
  const body = html.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.match(body, /catch\s*\([^)]*\)\s*\{[\s\S]*?state\.running=false/, 'catch 路径必须复位 state.running')
})

check('会议失败链路：阶段/模型 → 后端 → 用户可见卡片', () => {
  assert.match(meeting, /error\.stage\s*=\s*phase/)
  assert.match(meeting, /error\.agentId\s*=\s*participant\.id/)
  assert.match(server, /entry\.errorStage/)
  assert.match(server, /entry\.errorAgent/)
  assert.match(html, /data\.errorStage/)
  assert.match(html, /data\.errorAgent/)
  assert.match(html, /STAGE_LABEL/)
  assert.match(html, /meetingOpenKeys/)
  assert.match(html, /id="meetingRetry"/)
})

check('会议插话链路：前端 → /interject → getInterjections → 三阶段提示词', () => {
  assert.match(server, /url\.pathname\.endsWith\('\/interject'\)/, '缺少插话端点')
  assert.match(server, /getInterjections: \(\) => entry\.interjections/, '运行中的会议没有暴露插话队列')
  assert.match(meeting, /getInterjections/, 'runMeeting 不接收插话')
  assert.match(meeting, /interjectNote\(\)/, '插话没有进入提示词')
  assert.match(meeting, /Owner interjections during this meeting/, '插话提示词缺少明确标记')
  assert.match(html, /liveMeetingId/, '前端没有跟踪进行中的会议')
  assert.match(html, /\/interject/, '前端没有真实发送插话')
  assert.match(html, /r\.status===409[\s\S]{0,120}interjectLate/, '会议结束后的插话没有诚实反馈')
  // The queue must reach all three post-proposal phases, not just one.
  const noteUses = (meeting.match(/interjectNote\(\)/g) || []).length
  assert.ok(noteUses >= 3, '插话只进入了 ' + noteUses + ' 个阶段（批判/投票/决策都应包含）')
})

check('运行目录与导出格式真的传给后端并受白名单约束', () => {
  assert.match(html, /runDir:String\(setting\('runDir'\)/)
  assert.match(html, /exportFormat:setting\('exportFormat'\)/)
  assert.match(server, /body\.runDir/)
  assert.match(server, /body\.exportFormat/)
  assert.match(server, /\^\[A-Za-z0-9_-\]/, '运行目录缺少相对路径白名单')
  assert.match(server, /运行目录必须在应用目录内/)
  assert.match(server, /exportFormat === 'md'/)
})

check('Agent 工具开关、步数、提问策略三层一致', () => {
  assert.match(html, /function agentRunParams\(\)/)
  assert.match(html, /function disabledTools\(\)/)
  assert.match(server, /body\.disabledTools/)
  assert.match(server, /body\.allowQuestions/)
  assert.match(runner, /disabledTools\.includes\(family\)/)
  assert.match(runner, /action === 'ask_user' && !allowQuestions/)
})

check('首次使用的密钥路径、热刷新与配置读取一致', () => {
  assert.match(config, /vaultNames/)
  assert.match(config, /vaultEnvFor\(p\.id\)/)
  assert.match(server, /readLiveConfig/)
  assert.match(html, /PROVIDER_ENV/)
  assert.match(html, /refreshRosterFromServer/)
  assert.match(html, /id="manageModelsBtn"/)
  assert.match(html, /saveManagedModels/)
  assert.match(html, /providerKeySaved/)
  assert.match(html, /providerChangeKey/)
  assert.match(html, /检测可用模型/)
  assert.match(html, /providerModelSearch/)
  assert.match(html, /pinProviderModelRows/)
  assert.match(html, /providerExpand/)
  assert.match(html, /providerModelsExpand/)
  assert.match(html, /discoveredBefore/)
  assert.match(html, /\/api\/providers\/probe/)
  assert.match(html, /\/api\/providers\/participant/)
  assert.match(html, /发现 \/ 刷新模型/)
  assert.doesNotMatch(html, /界面上直接添加<b>计划中<\/b>/)
})

check('账号登录后隐藏登录/注册，只保留账号信息与切换账号', () => {
  assert.match(html, /id="accountAuth"/)
  assert.match(html, /id="accountSignedIn"/)
  assert.match(html, /id="accountSwitch"/)
  assert.match(html, /auth\.hidden=signedIn/)
  assert.match(html, /signedBlock\.hidden=!signedIn/)
})

check('危险操作确认两档有真实差别（不是死设置）', () => {
  assert.match(html, /data-confirm="high"/)
  assert.match(html, /setting\('confirmDanger'\)==='high'&&!highRisk/)
  assert.ok((html.match(/highRisk:false/g) || []).length >= 2,
    '「仅高风险确认」没有任何低风险操作可以跳过')
  // Truly irreversible actions must never be skippable.
  assert.match(html, /confirmAction\('删除本机文件'[\s\S]{0,240}\{danger:true/)
  assert.match(html, /confirmAction\('彻底删除会话'[\s\S]{0,240}\{danger:true/)
})

check('打开本机目录走白名单 IPC，不是假按钮', () => {
  assert.match(preload, /openPath: \(kind\)/)
  assert.match(main, /ipcMain\.handle\('open-path'/)
  assert.match(main, /path outside application (data )?directory/)
  assert.match(html, /function openPathSafe\(kind\)/)
})

check('滚动条、键盘焦点、窄屏断点与减弱动效都在', () => {
  for (const token of ['scrollbar-width', '::-webkit-scrollbar', ':focus-visible',
    '@media(max-width:1100px)', '@media(max-width:960px)', 'prefers-reduced-motion']) {
    assert.ok(html.includes(token), '缺少 ' + token)
  }
  assert.doesNotMatch(html, /scrollbar-width\s*:\s*none/)
  assert.doesNotMatch(html, /::-webkit-scrollbar\{display:none/)
})

check('浅色与深色的正文/辅助文字对比度达到 WCAG AA', () => {
  const toks = (block) => Object.fromEntries(
    [...block.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]))
  const light = toks(html.match(/:root\{([\s\S]*?)\n\}/)[1])
  const dark = toks(html.match(/html\[data-theme="dark"\]\{([\s\S]*?)\n\}/)[1])
  const luminance = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const pairs = [
    ['浅色 正文/背景', light.text, light.bg],
    ['浅色 正文/卡片', light.text, light.surface],
    ['浅色 辅助/卡片', light.muted, light.surface],
    ['浅色 辅助/次级卡片', light.dim, light.surface2],
    ['浅色 强调色/卡片', light.accent, light.surface],
    ['深色 正文/背景', dark.text, dark.bg],
    ['深色 正文/卡片', dark.text, dark.surface],
    ['深色 辅助/卡片', dark.muted, dark.surface],
    ['深色 辅助/次级卡片', dark.muted, dark.surface2],
    ['深色 强调色/次级卡片', dark.accent, dark.surface2],
  ]
  for (const [name, fg, bg] of pairs) {
    assert.ok(fg && bg, name + ' 缺少颜色变量')
    const r = ratio(fg, bg)
    assert.ok(r >= 4.5, name + ' 对比度只有 ' + r.toFixed(2) + ':1（需要 ≥ 4.5:1）')
  }
})

check('弹层具备可读名称与 aria 状态', () => {
  assert.match(html, /id="uiDialog" aria-hidden="true"/)
  assert.match(html, /role="switch"/)
  assert.match(html, /aria-label="搜索设置/)
  assert.ok(!/敬请期待|coming soon|TODO|占位按钮|假数据/.test(html), '出现占位/假完成文案')
})

// ---------------------------------------------------------------------------
// Third audit round (2026-11-08). Each check below corresponds to a problem
// that was observed in the running app, not to a theoretical one.
// ---------------------------------------------------------------------------

check('会话文件写入是原子的，并且不会覆盖别的实例', () => {
  // A second panel process (or a second window) used to overwrite the session
  // file with its own in-memory copy, silently destroying saved sessions.
  assert.match(sessionStore, /const reload = \(\) =>/, '会话存储不会在读取前重读磁盘')
  assert.match(sessionStore, /merged\.set\(s\.id, s\)/, '写入前没有按 id 合并磁盘上的会话')
  assert.match(sessionStore, /fs\.renameSync\(tmpFile, file\)/, '会话文件不是原子写入（临时文件 + rename）')
  assert.match(sessionStore, /backupFile/, '会话文件没有保留 .bak 兜底')
  assert.match(sessionStore, /purgeArchivedOlderThan/, '没有归档保留策略')
})

check('开会前写的补充约束会进入会议，不会被静默吞掉', () => {
  assert.match(html, /state\.pendingNotes\.push\(t\)/, '插话没有进入待发送队列')
  assert.match(html, /【会前补充约束】/, '待发送约束没有并入会议 brief')
  assert.match(html, /brief:fullBrief/, '会议请求没有发送合并后的 brief')
  assert.match(html, /renderPendingNotes\(\)/, '待发送约束没有在界面上可见')
  assert.match(html, /id="pendingNotes"/, '界面缺少待发送约束的显示位置')
})

check('模型面板不会盖住输入框', () => {
  assert.match(html, /function positionModelPanel\(\)/, '没有按输入框位置定位模型面板')
  assert.match(html, /--panel-bottom/, '模型面板没有使用 --panel-bottom')
  assert.match(html, /window\.addEventListener\('resize'/, '窗口变化时没有重新定位面板')
})

check('上下文轨道不再伪造压缩状态', () => {
  // The label mapping itself is what lied: it derived "压缩上下文" from the
  // message index. A leftover CSS selector for that kind is harmless.
  assert.ok(!/\['compressed','压缩上下文'\]/.test(html), '轨道仍然按消息序号伪造"压缩上下文"')
  assert.ok(!/compressedCount/.test(html), '轨道仍然按消息数量估算压缩比例')
  assert.match(html, /历史消息/, '轨道没有使用真实的历史标签')
})

check('导出的设置真的包含阵容', () => {
  assert.match(html, /data\.roster=\{selected:selectedIds\(\)/, '导出文件里没有阵容')
  assert.match(html, /pinnedModels:\[\.\.\.\(state\.settings\.pinnedModels/, '导出文件里没有置顶模型')
  assert.match(html, /if\(data\.roster&&typeof data\.roster==='object'\)/, '导入时不读回阵容')
})

check('强调色文字与按钮填充色分开，浅深主题都够对比度', () => {
  assert.match(html, /--accent-ink/, '没有区分强调色文字与强调色填充')
  assert.match(html, /function inkFor\(hex,theme\)/, '没有按主题推导强调色文字色')
  // The applied accent must not be the light-theme value in dark mode.
  assert.match(html, /root\.style\.setProperty\('--accent-ink',inkFor\(a,resolveTheme\(\)\)\)/)
})

check('深色主题下原生控件跟随主题', () => {
  assert.match(html, /color-scheme:light/, '浅色主题没有声明 color-scheme')
  assert.match(html, /color-scheme:dark/, '深色主题没有声明 color-scheme')
  // A <button class="pill"> kept the UA ButtonFace background, which made the
  // permission badge almost invisible in the dark theme.
  assert.match(html, /\.pill\{[^}]*background:transparent/, 'pill 按钮没有透明背景')
})

check('窄窗口真的会收窄侧栏（不是只写在说明里）', () => {
  assert.match(html, /--sidebar-cap/, '缺少 --sidebar-cap')
  assert.match(html, /--sidebar:min\(var\(--sidebar-user\),var\(--sidebar-cap\)\)/, '侧栏宽度没有取用户值与上限的较小者')
  assert.match(html, /setProperty\('--sidebar-user'/, '设置写入的不是 --sidebar-user')
  assert.doesNotMatch(html, /setProperty\('--sidebar',String\(setting\('sidebarWidth'\)\)/, '设置仍然直接覆盖 --sidebar，媒体查询会失效')
})

check('文本裁剪不依赖 -webkit-box（Electron 36 的 Chromium 会退化成 flow-root）', () => {
  assert.doesNotMatch(html, /\.plugin \.plugin-desc\{[^}]*-webkit-line-clamp/, '插件卡片仍依赖 -webkit-box 钳制')
  assert.match(html, /function clampLines\(el,lines\)/, '没有按实际盒子高度裁剪文本')
  assert.match(html, /const box=el\.clientHeight/, '裁剪没有使用 CSS 已经预留的盒子高度')
})

check('新增的设置项都接到了真实行为', () => {
  assert.match(html, /data-key="sessionRetention"/, '缺少归档保留设置')
  assert.match(html, /applyRetentionPolicy/, '归档保留没有生效逻辑')
  assert.match(server, /\/api\/policy/, '后端缺少保留策略接口')
  assert.match(server, /purgeArchivedOlderThan/, '后端没有执行保留策略')
  assert.match(html, /data-key="pluginFilter"/, '缺少插件过滤设置')
  assert.match(html, /kind==='npm'&&!p\.npm/, '插件过滤没有真的过滤')
  assert.match(server, /\/api\/cache\/clear/, '后端缺少清空缓存接口')
  assert.match(html, /id="resetPermissionBtn"/, '缺少恢复只读权限的入口')
  assert.match(html, /mode:'read-only'/, '恢复只读没有真的调用权限接口')
})

// ---------------------------------------------------------------------------
// Fourth audit round (2026-11-08 evening). The waiting experience: a running
// meeting must look alive, name its phase, and be exitable.
// ---------------------------------------------------------------------------

check('会议等待期有真实进度卡：阶段、耗时、参与模型都来自轮询数据', () => {
  assert.match(html, /function renderLiveProgress\(/, '没有进度卡渲染函数')
  assert.match(html, /\.meeting-progress\{/, '进度卡没有样式')
  assert.match(html, /PHASE_STEPS=\['独立提案','交叉批判','Condorcet 投票','主 Bot 决策'\]/, '阶段步进器与引擎 onPhase 的四个阶段不一致')
  assert.match(html, /progress\.update\(data,seconds/, '轮询数据没有喂给进度卡')
  assert.match(html, /mp-elapsed/, '进度卡没有耗时显示')
})

check('放弃等待是诚实的：不宣称取消会议，后台结果仍会入会话列表', () => {
  assert.match(html, /放弃等待/, '进度卡没有退出等待的入口')
  assert.ok(!/已取消会议|已终止会议/.test(html), '放弃按钮谎称取消了会议（后端没有 abort 接口）')
  assert.match(html, /已停止等待这场会议/, '放弃后没有说明会议仍在后台运行')
  assert.match(html, /后台会议已完成 · 顶栏「决策书」可查看/, '后台完成的会议没有可见的落点')
  assert.match(html, /state\.running=false/, '放弃后没有解锁界面')
  // A meeting that finished while unwatched must still be recorded.
  assert.match(html, /决议（后台完成）/, '后台完成的结果没有写入会话记录')
})

check('两个会议不会写同一块信息流（放弃/新开后旧循环静默记录）', () => {
  assert.match(html, /meetingRunToken/, '没有会议令牌机制')
  assert.match(html, /const quiet=abandoned\|\|superseded/, '没有安静模式')
  assert.match(html, /if\(myToken!==meetingRunToken\)return/, '被新会议取代的旧循环仍会写界面')
})

check('新会议弹窗不再被浮层压住，运行中发起有反馈', () => {
  assert.match(html, /openNewMeetingModal[\s\S]{0,600}\.model-panel\.open/, '打开新会议时没有先关闭模型面板')
  assert.match(html, /已有一场会议在等待结果/, '会议运行中点「开始会议」没有提示')
})

check('插话提示行会自动复位，不会永久停在上一条消息', () => {
  assert.match(html, /function setHint\(/, '没有提示复位机制')
  assert.match(html, /DEFAULT_MEETING_HINT/, '没有默认提示文案常量')
  assert.match(html, /setHint\('已排队 '/, '插话反馈没有走复位机制')
})

// ---------------------------------------------------------------------------
// Fourth round, part 2: engine per-call progress, idle plugin prefetch,
// launcher stale-service guard.
// ---------------------------------------------------------------------------

check('逐模型进度：引擎上报 → 服务端透传 → 进度卡 N/M 计数', () => {
  assert.match(meeting, /onProgress\?\.\(\{ phase: '独立提案', done: proposalDone, total: proposalTotal \}\)/, '引擎没有上报提案进度')
  assert.match(meeting, /onProgress\?\.\(\{ phase: '交叉批判', done: critiqueDone, total: participants\.length \}\)/, '引擎没有上报批判进度')
  assert.match(meeting, /onProgress\?\.\(\{ phase: 'Condorcet 投票', done: voteDone, total: voteTotal \}\)/, '引擎没有上报投票进度')
  assert.ok((meeting.match(/onProgress\?\.\(/g) || []).length >= 3, '进度上报点不足（三个阶段都要报）')
  // Each phase's reporter must be called from both the success and the error
  // path: a failed call also finishes that step for the waiting user.
  for (const fn of ['reportProposalProgress', 'reportCritiqueProgress', 'reportVoteProgress']) {
    assert.ok((meeting.match(new RegExp(fn + '\\(\\)', 'g')) || []).length >= 2, fn + ' 没有同时挂在成功与失败路径上')
  }
  assert.match(server, /onProgress: \(step\)/, '服务端没有透传进度到 run entry')
  assert.match(server, /entry\.progress/, 'run entry 没有保存进度')
  assert.match(html, /data\?\.progress/, '前端没有读取进度')
  assert.match(html, /phase\+' '\+c\.done\+'\/'\+c\.total/, '进度卡没有渲染 N/M 计数')
})

check('插件目录空闲预取，且并发加载共享同一次请求', () => {
  assert.match(html, /requestIdleCallback\(warmCatalog/, '没有空闲预取')
  assert.match(html, /pluginCatalogLoading/, '没有 in-flight 共享')
  assert.match(html, /if\(pluginCatalogLoading\)return pluginCatalogLoading/, '并发调用会重复下载 8.5MB 目录')
})

check('启动脚本不复用旧版本面板服务（Edge 回退分支校验版本）', () => {
  assert.match(launcher, /servedVersion -ne \$expectedVersion/, '回退分支没有比对服务版本')
  assert.match(launcher, /held by an older MeetingBot panel/, '版本不符时没有明确报错')
  assert.match(launcher, /Get-NetTCPConnection -LocalPort/, '没有报告占用端口的进程')
})

check('插件卡片钳制可在视图显示后重跑（空闲预取不会让省略号消失）', () => {
  assert.match(html, /el\.dataset\.full/, '钳制没有保存原文，隐藏视图渲染后无法重跑')
  assert.match(html, /reclampPluginDescs/, '切到插件视图时没有重新钳制')
  assert.match(html, /if\(name==='plugins'\)requestAnimationFrame\(\(\)=>reclampPluginDescs\(\)\)/, '重钳制没有绑定到视图切换')
})

check('放弃等待后后台失败也有中文说明和下一步，不只一行英文内部错误', () => {
  assert.match(html, /这场会议没能完成/, '后台失败没有中文说明')
  assert.match(html, /bgMeetingRetry/, '后台失败没有重试入口')
  assert.match(html, /bgMeetingRoster/, '后台失败没有换模型入口')
  assert.match(html, /阶段：/, '后台失败没有点名失败阶段')
  assert.match(html, /if\(abandoned\)\{/, '后台失败没有走放弃分支')
  assert.doesNotMatch(html, /后台会议失败 · /, '还在把英文内部错误直接塞状态栏')
})

check('MCP tab is optional, reachable, and read-only gated', () => {
  assert.match(html, /data-tool-tab="mcp"/, 'MCP tab missing')
  assert.match(html, /id="tool-mcp"/, 'MCP panel missing')
  assert.match(html, /readOnly:true/, 'MCP panel does not explain readOnly gating')
  assert.match(server, /\/api\/mcp\/status/, 'MCP status endpoint missing')
  assert.match(server, /permission: permissions.current\(\)\.id/, 'MCP endpoint does not pass live permission')
})

check('Follow-up meeting is wired from decision to parentRunId', () => {
  assert.match(html, /data-followup/, 'decision card missing follow-up button')
  assert.match(html, /\/api\/meetings\/followup-brief/, 'panel does not request follow-up brief')
  assert.match(html, /parentRunId:pendingParentRunId/, 'meeting start does not send parentRunId')
  assert.match(server, /\/api\/meetings\/followup-brief/, 'server follow-up endpoint missing')
  assert.match(meeting, /parentRunId: String\(parentRunId/, 'run metadata does not record parentRunId')
})

check('MCP can be disabled from the UI and server whitelist', () => {
  assert.match(html, /toolMcp/, 'MCP tool setting missing')
  assert.match(html, /out\.push\('mcp'\)/, 'disabledTools does not include mcp')
  assert.match(server, /'browser', 'files', 'python', 'mcp'/, 'server silently drops mcp from disabledTools')
})

// ---------------------------------------------------------------------------
// UX round (2026-11-09). Each check maps to one acceptance item in the brief.
// ---------------------------------------------------------------------------

check('面板里没有重复 id（每个入口只有一个真实 DOM）', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  assert.deepEqual(dup, [], '重复 id: ' + dup.join(', '))
})

check('工作区固定，只有最近会话列表与主内容区各自滚动', () => {
  assert.match(html, /\.side-scroll\{[^}]*overflow:hidden/)
  assert.match(html, /\.side-workspace\{[^}]*flex:0 0 auto/)
  assert.match(html, /\.chat-list\{[^}]*overflow-y:auto/)
  assert.match(html, /class="side-workspace"/)
  assert.match(html, /class="side-recent"/)
  assert.match(html, /\.main\{[^}]*min-height:0/)
})

check('常用 / 不常用可折叠，首次全部常用，分组状态持久化', () => {
  for (const token of ['workspaceCommonToggle', 'workspaceMoreToggle', 'workspaceCommon', 'workspaceMore', 'workspaceGroupPrefs']) {
    assert.ok(html.includes('id="' + token + '"'), '缺少 ' + token)
  }
  assert.match(html, /meetingbot\.workspaceCommon/)
  assert.match(html, /meetingbot\.workspaceCommonOpen/)
  assert.match(html, /meetingbot\.workspaceMoreOpen/)
  assert.match(html, /return WORKSPACE_ITEMS\.map\(\(\[key\]\)=>key\)/, '首次不是全部常用')
  const items = html.match(/const WORKSPACE_ITEMS=\[([\s\S]*?)\];/)[1]
  for (const name of ['合议', '分工', '点将', '私聊', '对照', '群聊', '插件']) {
    assert.ok(items.includes("'" + name + "'"), '工作区缺少 ' + name)
  }
  // 2026-11-10 follow-up: 运行 lives in Settings only (the owner does not want
  // it occupying the workspace). 工具 = dock, 任务 = hidden detail page.
  assert.ok(!items.includes("'运行'") && !items.includes("'工具'") && !items.includes("'任务'"), '工作区混进了非一级入口')
  assert.match(html, /id="settingsRunsOpen"/, '设置里缺少运行中心入口')
  assert.doesNotMatch(html, /class="nav" data-view="runs"/, '运行仍占工作区一级入口')
  assert.doesNotMatch(html, /data-view="jobs"/, '后台任务仍占工作区一级入口')
  assert.doesNotMatch(html, /data-view="tools"/, '工具仍占工作区一级入口')
})

check('顶栏工具按钮与窗口控制、权限、后台任务胶囊不重叠', () => {
  assert.match(html, /id="toolPaletteBtn"[^>]*data-palette-view="tools"/)
  assert.ok(html.indexOf('id="backgroundJobsPill"') < html.indexOf('class="top-actions"'))
  assert.ok(html.indexOf('id="permissionBadge"') < html.indexOf('id="toolPaletteBtn"'))
  assert.ok(html.indexOf('id="toolPaletteBtn"') < html.indexOf('id="windowControls"'))
  assert.match(html, /\.top-actions>\*\{flex:0 0 auto\}/)
  assert.doesNotMatch(html, /id="toolPalette"/, '工具下拉小菜单还在（存在未绑定按钮）')
})

check('工具半屏分屏：左侧保留、关闭在工具头部、状态持久化、窄屏全宽', () => {
  assert.match(html, /body\.tool-split \.main\{margin-right:50vw\}/)
  assert.match(html, /body\.tool-split #view-tools\{[^}]*top:58px/, '工具页盖住了顶栏窗口控制')
  assert.match(html, /body\.tool-split #toolPaletteBtn\{display:none!important\}/)
  assert.match(html, /@media\(max-width:900px\)\{body\.tool-split \.main\{margin-right:0\}body\.tool-split #view-tools\{width:100vw\}/)
  assert.match(html, /meetingbot\.toolSplitOpen/)
  assert.ok(html.indexOf('id="toolDockClose"') < html.indexOf('id="toolTabs"'), '关闭按钮不在工具页头部')
  for (const tab of ['browser', 'files', 'python', 'agent', 'mcp']) {
    assert.ok(html.includes('data-tool-tab="' + tab + '"'), '工具页缺少 ' + tab)
  }
})

check('记忆库是原创知识卡工作台：无 iframe、不读 7999、数据只在自己的 dataRoot', () => {
  const iframeTags = html.match(/<iframe[^>]*>/gi) || []
  assert.ok(iframeTags.every((tag) => /id="aiDockFrame"/.test(tag)), '记忆库不允许 iframe；只有副屏容器可例外')
  assert.doesNotMatch(html, /7999|memory-vault|memory-eternal/)
  assert.doesNotMatch(server, /7999|memory-vault|memory-eternal/)
  assert.doesNotMatch(memoryStore, /7999|memory-vault|memory-eternal/)
  assert.match(memoryStore, /path\.join\(dataRoot, 'state', 'memory\.json'\)/)
  assert.match(memoryStore, /resolveDataRoot/)
  assert.match(server, /url\.pathname === '\/api\/memory'/)
  for (const token of ['memoryCountAll', 'memoryCountCore', 'memoryCountPending', 'memoryStats', 'memorySearch', 'memoryNewToggle', 'memoryAddPanel', 'memoryList', 'memoryExport', 'memoryImportBtn', 'memoryKind', 'memoryFormStatus']) {
    assert.ok(html.includes('id="' + token + '"'), '记忆库缺少 ' + token)
  }
  assert.match(html, /把项目约束、偏好和已确认的决策记在这里；新卡可以先放入待审，通过后才进入长期记忆。/)
  for (const action of ['data-memory-approve', 'data-memory-reject', 'data-memory-delete', 'data-memory-core']) {
    assert.ok(html.includes(action), '记忆库缺少操作 ' + action)
  }
  for (const tab of ['all', 'core', 'pending']) assert.ok(html.includes('data-memory-tab="' + tab + '"'))
  assert.ok(html.includes('class="memory-stats"'))
  assert.match(html, /<span class="memory-stat">技能/)
})

check('插件市场：整行大搜索、来源分类、管理与投稿两个独立弹窗', () => {
  assert.match(html, /class="plugin-search-row"[^>]*>[\s\S]{0,220}id="pluginSearch"/)
  assert.doesNotMatch(html, /id="pluginVendor"/, '来源控件仍挤在搜索同一行')
  for (const src of ['all', 'official', 'third']) assert.ok(html.includes('data-plugin-source="' + src + '"'))
  assert.match(html, /pluginSourceFilter/)
  assert.ok(html.includes('id="pluginAdminModal"') && html.includes('id="pluginSubmitModal"'))
  assert.match(html, /function openPluginAdmin\(\)\{[\s\S]{0,400}pluginSubmitModal[\s\S]{0,200}classList\.remove\('open'\)/, '打开管理时没有关掉投稿弹窗')
  assert.match(html, /\$\('#pluginSubmit'\)\.onclick=\(\)=>\{closeAdmin\(\)/, '打开投稿时没有关掉管理弹窗')
  assert.match(html, /plugin-disclaimer[\s\S]{0,80}第三方插件风险提示/)
  assert.match(html, /pluginFeedback\(/)
})

check('官方插件只能打开 / 详情 / 启停，第三方才可安装与卸载', () => {
  assert.match(html, /official\?`<button type="button" class="send-plugin" data-plugin-open=/)
  assert.match(html, /data-plugin-install=/)
  assert.match(html, /renderPluginAdmin[\s\S]{0,1400}不可卸载/)
  assert.match(html, /row\.official\?'':`<button class="ghost-btn" type="button" data-plugin-remove=/)
  assert.match(html, /OFFICIAL_PLUGINS=\[[\s\S]{0,1200}后台任务[\s\S]{0,600}决策本体/)
  assert.match(html, /meetingbot\.officialDisabled/)
  assert.match(html, /meetingbot\.pluginInstalled/)
  assert.match(html, /meetingbot\.pluginSubmissions/)
})

check('后台任务不占工作区；胶囊显示真实数量、4 秒刷新、设置里有入口', () => {
  assert.doesNotMatch(html, /data-view="jobs"/)
  assert.match(html, /id="backgroundJobsPill"/)
  assert.match(html, /setInterval\(refreshJobsPill,4000\)/)
  assert.match(html, /const active=all\.filter\(job=>\['running','queued','cancel-requested'\]\.includes\(job\.status\)\)\.length/)
  assert.match(html, /pill\.textContent=active\?active\+' 个后台任务':'后台任务'/)
  assert.match(html, /id="jobSettingsCount"/)
  assert.match(html, /id="jobSettingsOpen"/)
  assert.match(html, /id="view-jobs"/)
  assert.match(html, /openJobDetail/)
  assert.match(server, /url\.pathname === '\/api\/jobs'/)
  assert.match(server, /\/api\/jobs\/'/)
})

check('对照：送出区只在结果后出现、单列复制真的绑定、无 4 个硬上限', () => {
  assert.match(html, /id="compareHandoff" hidden/)
  assert.match(html, /handoff\.hidden=false/)
  assert.match(html, /if\(handoff\)handoff\.hidden=true/)
  assert.match(html, /data-compare-copy="\$\{results\.indexOf\(result\)\}"/)
  assert.match(html, /\.closest\?\.\('\[data-compare-copy\]'\)/)
  assert.match(html, /if\(ids\.length<2\)/)
  assert.doesNotMatch(html, /ids\.length>4|slice\(0,4\)/)
  assert.match(html, /compareHistoryRemember/)
  assert.match(html, /compareToMeeting[\s\S]{0,80}compareToGroup[\s\S]{0,80}compareExport/)
})

check('本轮新增控件都有真实绑定，不是死按钮', () => {
  const wired = [
    ['officialPluginManage', /\$\('#officialPluginManage'\)\.onclick=openPluginAdmin/],
    ['memoryImportBtn', /\$\('#memoryImportBtn'\)\?\.addEventListener/],
    ['memoryImportFile', /memoryImportFile'\)\?\.addEventListener\('change'/],
    ['memoryKind', /\$\('#memoryKind'\)\?\.value/],
    ['toolDockClose', /\$\('#toolDockClose'\)\?\.addEventListener/],
    ['pluginDetailOpen', /openBtn\.onclick=/],
    ['jobDetail', /openJobDetail\(row\.dataset\.jobOpen\)/],
    ['pluginFeedback', /function pluginFeedback\(/],
    ['pluginSourceTabs', /\$\$\('#pluginSourceTabs button'\)\.forEach\(btn=>btn\.onclick=/],
  ]
  for (const [id, pattern] of wired) {
    assert.ok(html.includes('id="' + id + '"'), id + ' 不存在')
    assert.ok(pattern.test(html), id + ' 没有真实绑定')
  }
})

check('本轮记忆工作台：模态编辑器、编辑/删除/待审/核心都有真实绑定，搜索本地即时过滤', () => {
  assert.match(html, /id="memoryAddPanel" aria-hidden="true"/)
  assert.match(html, /function openMemoryEditor\(entry=null\)/)
  assert.match(html, /data-memory-edit=/)
  assert.match(html, /memoryState\.query=e\.target\.value\.trim\(\)/)
  assert.match(html, /setTimeout\(renderMemory,120\)/)
  assert.match(html, /id="memoryStatus" role="status"/)
  assert.match(html, /id="memoryTitle" maxlength="120"/)
  const memoryIframes = html.match(/<iframe[^>]*>/gi) || []
  assert.ok(memoryIframes.every((tag) => /id="aiDockFrame"/.test(tag)), '记忆工作台不允许 iframe；只有副屏容器可例外')
})

check('本轮插件市场：官方停用后仍可见但不出现伪安装，第三方按钮叫安装并落盘到登记表', () => {
  assert.match(html, /data-plugin-install="\$\{idx\}"/)
  assert.match(html, /'已安装':'安装'/)
  assert.match(html, /data-plugin-open="\$\{idx\}" \$\{disabled/)
  assert.match(html, /官方插件<\/b><small>合议内置能力：只能启用 \/ 停用，不能卸载/)
  assert.match(html, /submitted:true/)
  assert.match(server, /pluginState\.registerThirdParty\(body\.id, body\)/)
  assert.match(html, /plugin-admin-state/)
})

check('本轮账号菜单承载版本 / 反馈 / 设置，对照历史与后台任务菜单都有真实落点', () => {
  assert.match(html, /id="accountVersion"/)
  assert.match(html, /id="accountMenu"[\s\S]{0,400}id="feedbackBtn"/)
  assert.match(html, /id="accountMenu"[\s\S]{0,400}data-view="settings"/)
  assert.doesNotMatch(html, /class="side-foot"/, '侧栏底部行已并入账号菜单')
  assert.match(html, /data-job-page/)
  assert.match(html, /class="compare-history"/)
  assert.match(html, /body\.tool-split \.memory-grid/)
})

check('本轮信息层级：每页标题正确、状态胶囊统一、唯一主按钮、版本在品牌名后', () => {
  assert.match(html, /const PAGE_META=\{/)
  for (const state of ['就绪', '本机索引', '仅本机', '立即生效', '本地记录', '队列']) {
    assert.ok(html.includes("'" + state + "'"), '缺少状态胶囊文案 ' + state)
  }
  for (const title of ['单 Agent 私聊', '同一问题，多个模型并排回答', '轻群聊 · 不投票', '插件市场', '知识卡', '设置', '让多个模型先开一次会，再动手', '按能力域分工，各出一版再交叉审查', '只叫最合适的模型，主责 + 审查兜底']) {
    assert.ok(html.includes(title), '缺少页面标题 ' + title)
  }
  assert.match(html, /class="send send-quiet" id="send"/, '合议页输入区按钮不是次级样式')
  assert.match(html, /\.send-quiet\{/, '缺少次级发送样式')
  assert.match(html, /function initModalFocus\(\)/, '弹窗没有焦点进入/归还')
  assert.match(html, /\.feed\{width:100%\}/, '阅读列没有撑满主区')
  assert.match(html, /class="page-head"/, '私聊页没有常驻页头')
  assert.match(html, /\.brand-version\{[^}]*margin-left/, '版本号没有紧挨品牌名')
  assert.doesNotMatch(html, /class="side-foot"/, '仍有底部版本横栏')
  assert.match(html, /#statusPill\{height:24px/, '状态胶囊没有统一样式')
})

// ---------------------------------------------------------------------------
// Design pass (2026-11-10): first screen, top bar, decision document.
// ---------------------------------------------------------------------------

check('首屏只留一张开工卡：引导卡让位、主 CTA 聚焦输入框', () => {
  // With two keyed models the welcome card + composer already answer "next",
  // so the 3-step setup guide must not stack a second 355px card below it.
  assert.match(html, /const setupReady=configuredCount\(\)>=2/, '引导卡没有按“已配置密钥”让位')
  assert.match(html, /onb\.hidden=meetingStarted\|\|hasChat\|\|setupReady/, '引导卡仍会在已配置后常驻')
  assert.match(html, /tools\.style\.display=\(meetingStarted\|\|hasChat\)\?'':'none'/, '空信息流仍显示重复的模式条')
  assert.match(html, /startBtn\.textContent='写需求，开始会议'/, '首屏主按钮不是“写需求”')
  assert.match(html, /input\.focus\(\);/, '主按钮没有把焦点交给输入框')
})
check('输入框里就能看到会前预估，不再只藏在弹窗里', () => {
  assert.match(html, /function refreshComposerEstimate\(\)/, '缺少输入框预估函数')
  assert.match(html, /saveDraft\('meeting',\$\('#input'\)\.value\);autoGrowComposer\(\);refreshComposerEstimate\(\)/, '输入事件没有刷新预估')
  assert.match(html, /约 '\+est\.total\.toLocaleString/, '预估文案没有真实数值')
  assert.match(html, /（预估，仅供参考）/, '预估没有标明仅供参考')
})
check('决策书是执行文档：清单可复制、批准紧跟任务、用量可跳运行中心', () => {
  assert.match(html, /function decisionCoreHtml\(/, '决策书没有共享构建器')
  assert.match(html, /decisionCoreHtml\(result,\{/, '信息流里的决议没有走共享构建器')
  assert.match(html, /function decisionTaskItems\(/, '下一步没有解析成任务清单')
  assert.match(html, /class="decision-tasks"/, '缺少任务清单结构')
  assert.match(html, /data-copy-tasks/, '任务清单不可复制')
  assert.match(html, /approvalHtml:result\.runDir\?/, '批准卡没有紧跟在任务清单后')
  assert.match(html, /data-open-runs/, '用量行没有直达运行中心')
  assert.match(html, /function decisionUsageHtml\(/, '缺少独立用量行')
  assert.match(html, /data-open-decision/, '信息流决议不能回到决策书')
})
check('顶栏只留工作控件；主题/快捷键移入账号菜单且绑定不变', () => {
  const topActions = html.match(/<div class="top-actions">([\s\S]*?)<\/div>/)[1]
  assert.ok(!topActions.includes('id="themeQuick"'), '主题按钮仍占顶栏')
  assert.ok(!topActions.includes('id="shortcutsBtn"'), '快捷键按钮仍占顶栏')
  assert.match(html, /id="accountMenu"[\s\S]{0,900}id="themeQuick"[\s\S]{0,300}id="shortcutsBtn"/, '账号菜单没有承载主题与快捷键')
  assert.match(html, /\$\('#themeQuick'\)\.onclick=/, '主题按钮绑定被破坏')
  assert.match(html, /\$\('#shortcutsBtn'\)\.onclick=/, '快捷键按钮绑定被破坏')
})
check('决策清单与首屏在窄窗口不撑破列', () => {
  assert.match(html, /\.decision-tasks \.dt-text\{min-width:0\}/, '任务文本没有 min-width:0')
  assert.match(html, /\.welcome-trust\{/, '首屏缺少信任说明行')
  assert.match(html, /@media\(max-width:640px\)\{\.welcome \.tools \.send\{width:100%\}/, '窄窗口主按钮没有占满一行')
})

check('参与者级状态：引擎逐模型上报 → 服务端透传 → 进度卡按状态渲染', () => {
  assert.match(meeting, /onParticipant\?\.\(\{/, '引擎没有可选的逐模型上报通道')
  assert.match(meeting, /reportParticipant\(participant, '独立提案', 'running'\)/, '提案开始时没有 running')
  assert.match(meeting, /reportParticipant\(participant, '独立提案', 'failed'\)/, '提案失败没有 failed')
  assert.ok((meeting.match(/reportParticipant\(/g) || []).length >= 10, '上报点不足（四个阶段都要报）')
  assert.match(server, /participants: \{\}/, '运行条目没有 participants map')
  assert.match(server, /onParticipant: \(person\)/, '服务端没有接 onParticipant')
  assert.match(server, /entry\.participants\[person\.agentId\]/, '服务端没有按模型 id 记录状态')
  assert.match(html, /class="mp-people"/, '进度卡缺少参与者状态行')
  assert.match(html, /data-status="waiting"/, '参与者初始状态不是等待')
  assert.match(html, /markPerson\(el,byId\[el\.dataset\.agentId\]\|\|'waiting',tokensById/, '进度卡没有按真实上报更新，而是猜状态')
  assert.match(html, /if\(key!==peopleKey\)\{/, '进度卡没有按服务端上报重建参与者列表')
  assert.match(html, /class="mp-tok"/, '参与者胶囊没有 token 位')
  assert.match(meeting, /tokens: prompt \+ completion/, '引擎没有把真实 usage 挂到参与者事件')
  assert.match(server, /tokens: \(Number\(prev\.tokens\) \|\| 0\) \+ \(Number\(person\.tokens\) \|\| 0\)/, '服务端没有按模型累加 token')
  assert.match(html, /\.mp-person\[data-status="failed"\]/, '失败状态没有视觉编码')
  assert.match(html, /body\.reduce-motion \.meeting-progress \.mp-person/, '动效减弱时没有停掉进行中脉冲')
})

check('用量页回答“花在哪”：花费/运行分栏、覆盖率、按模型、每场成本', () => {
  assert.match(html, /id="usageTabs"/, '用量页没有花费/运行分栏')
  assert.match(html, /data-usage-tab="spend"/, '缺少花费 tab')
  assert.match(html, /id="usageSpend"/, '缺少花费面板')
  assert.match(html, /id="usageRuns" hidden/, '缺少运行记录面板')
  assert.match(html, /const coverage=callRows>0/, '没有调用覆盖率')
  assert.match(html, /usage\.byModel/, '仍然只按厂商汇总，没有按模型')
  assert.match(html, /id="usageTopRuns"/, '没有每场成本列表')
  assert.match(html, /run\.failedCalls/, '运行记录没有失败处数')
  assert.match(html, /setUsageTab\('spend'\)/, '分栏没有默认花费')
  assert.match(html, /token 是数量不是金额/, '没有说明 token 不等于金额')
  assert.match(html, /usageFamilyKey\(/, '按模型行没有厂商配色映射')
})

check('会议输入框随内容长高且有上限', () => {
  assert.match(html, /function autoGrowComposer\(/, '没有输入框自动长高函数')
  assert.match(html, /max-height:min\(34vh,260px\)/, '输入框没有视口上限')
  assert.match(html, /autoGrowComposer\(\);/, '输入事件没有触发布局重算')
})

check('决策书可直达决策台账', () => {
  assert.match(html, /id="decisionLedgerBtn"/, '决策页没有决策台账入口')
  assert.match(html, /data-usage-tab="ledger"/, 'Run Center 没有决策台账 tab')
  assert.match(html, /\/api\/decisions\/ledger/, '服务端没有决策台账 API')
})

check('文件可以直接拖进会议输入框', () => {
  assert.match(html, /drop-target/, '输入框没有拖拽高亮')
  assert.match(html, /addFiles\(e\.dataTransfer\?\.files,'drop'\)/, 'drop 没有复用文件导入流程')
  assert.match(html, /检测到项目或大文本/, '大项目拖入没有引导到工作区')
  assert.match(html, /没有可用的本地路径/, '无路径的二进制/文档没有被引导')
  assert.match(html, /kind==='image'/, '图片附件没有视觉分类')
  assert.match(html, /kind==='reference'/, 'Office/压缩包没有本地引用分类')
  assert.match(html, /添加文本文件/, '附件入口没有说明格式分层')
  assert.match(html, /maxFiles:32/, '工作区扫描没有提高项目文件上限')
  assert.match(html, /dragenter/, '输入框没有接收拖拽事件')
})

check('文件以附件 chip 加入，而不是塞进输入框', () => {
  assert.match(html, /id="composerAttachments"/, '缺少附件 chip 区域')
  assert.match(html, /function addComposerAttachment\(/, '缺少附件入列函数')
  assert.match(html, /function briefWithComposerAttachments\(/, '附件没有随 brief 送入会议')
  assert.match(html, /路径：/, '附件 brief 没有文件路径映射')
  assert.match(html, /getPathForFile/, 'Electron 附件没有取绝对路径')
  assert.match(html, /clearComposerAttachments\(\)/, '发送后没有清理附件')
})

check('论文/报告写作模式会进入会议 brief', () => {
  assert.match(html, /id="writingMode"/, '缺少写作模式选择器')
  assert.match(html, /id="paperTask"/, '缺少论文阶段选择器')
  assert.match(html, /const PAPER_TASK_GUIDE=/, '缺少论文阶段约束')
  assert.match(html, /withWritingMode\(brief\)/, '启动会议没有应用写作模式')
  assert.match(html, /不伪造数据、作者、DOI/, '论文模式缺少引用边界')
})

check('提示词优化星标：思考、采用、重试、看原文', () => {
  assert.match(html, /id="promptOptimize"/, '缺少提示词优化星标')
  assert.match(html, /id="promptOptimizerText"/, '缺少优化预览')
  assert.match(html, /id="promptOptimizerRetry"/, '缺少重新思考')
  assert.match(html, /id="promptOptimizerOriginal"/, '缺少看原文')
  assert.match(html, /addEventListener\('dblclick'/, '双击没有切换原文')
  assert.match(server, /\/api\/prompt\/optimize/, '服务端没有提示词优化接口')
})

check('同材料可从零重跑，不强制复用缓存', () => {
  assert.match(html, /id="noCacheToggle"/, '缺少从零重跑开关')
  assert.match(html, /noCache:state\.settings\.noCache===true/, '启动请求没有传 noCache')
  assert.match(html, /本场从零重跑/, '开关没有解释缓存行为')
})

check('决策书先给结论，再给动作和验收', () => {
  assert.match(html, /decision-verdict/, '决策书缺少一句话结论')
  assert.match(html, /decision-scope/, '决策书没有区分决策与执行')
  assert.match(html, /这是会议决策，不是执行结果/, '没有防误读说明')
  assert.match(html, /decision-essential/, '决策书缺少动作/验收/负责人摘要')
  assert.match(html, /怎么验收/, '决策书没有验收标准')
  assert.match(html, /Condorcet 获胜/, '计票只显示“见报告”')
  assert.match(html, /decision-models/, '决策书没有各模型提案对照')
  assert.match(html, /decision-election/, '决策书没有选举/fallback 说明')
  assert.match(html, /weighted-average-fallback/, '决策书没有说明 Condorcet 循环 fallback')
  assert.match(html, /data-run-decision/, 'Run Center 没有打开历史决策书入口')
  assert.match(server, /invalid run id/, '服务端没有历史决策书接口')
})

check('已完成 run 重跑前必须确认', () => {
  assert.match(html, /data-run-status/, '重试按钮没有携带完成状态')
  assert.match(html, /重跑整场会议/, '已完成 run 重跑没有确认')
})

check('空闲时 Enter 不再直接发起付费会议', () => {
  assert.match(html, /Enter 换行/, '提示条仍把 Enter 写成排队/发送')
  assert.match(html, /Plain Enter and Shift\+Enter insert a newline/, 'Enter 没有改为换行')
  assert.match(html, /nmBrief.*ctrlKey\|.*metaKey/s, '新会议长文本 Enter 仍会直接开始')
})

check('执行批准默认不勾选，并显式全选/清空', () => {
  assert.match(html, /默认不勾选/, '批准弹窗仍默认全选')
  assert.match(html, /data-approval-select-all/, '缺少全选按钮')
  assert.match(html, /data-approval-select-none/, '缺少清空按钮')
})

check('决策书先给执行清单，再给提案和票型', () => {
  assert.match(html, /\+taskBlock[\s\S]{0,300}\+proposalHtml/, '提案仍排在执行清单前')
})

check('历史会话保存 runDir 和 executionIntent', () => {
  assert.match(html, /runDir:String\(result\.runDir/, '会话没有保存 runDir')
  assert.match(html, /executionIntent:result\.executionIntent/, '会话没有保存执行意图')
  assert.match(sessionStore, /runDir: String\(input\.runDir/, 'session-store 没有接收 runDir')
})
check('设计修复：权限/运行/后台状态', () => {
  assert.match(html, /id="runNavBtn"/, '顶栏没有运行入口')
  assert.match(html, /后台继续/, '放弃等待仍写成停止')
  assert.match(html, /停止后续阶段/, '停止按钮没有说明只停后续阶段')
  assert.match(html, /step\.result\?\.path/, '执行轨迹没有显示触碰文件')
  assert.match(html, /noCacheToggle\.checked=false/, '从零重跑没有在开跑后复位')
  assert.match(html, /data-open-history-decision/, '历史决策书没有完整打开入口')
  assert.doesNotMatch(html, /已进行<\/span>/, '失败卡仍有“已进行：运行中”')
  assert.match(html, /会议模式已切换为/, '切模式仍无提示/保护')
  assert.match(html, /新建会议？/, '新建会议仍会无确认清空草稿')
  assert.match(html, /data-copy-decision/, '决策书没有复制全文')
  assert.match(html, /data-export-decision/, '决策书没有导出 Markdown')
  assert.match(html, /删除会改动文件/, '删除审批没有风险警告')
  assert.doesNotMatch(html, /throw new Error\('meeting timeout'\)/, '超时仍被直接判失败')
})

check('执行阶段显示主 Bot 轨迹并立即请求权限', () => {
  assert.match(html, /id="approvalExecution"/, '执行后没有可见轨迹区域')
  assert.match(html, /function renderApprovalExecution\(/, '没有执行轨迹渲染')
  assert.match(html, /data\.needsInput[\s\S]{0,200}showAgentQuestion/, '执行需要权限时没有立即弹窗')
  assert.match(html, /主 Bot 正在执行/, '执行中没有可见状态')
})

check('执行意图前置，只决策时不生成批准卡', () => {
  assert.match(html, /id="meetingIntentModal"/, '开场前没有执行意图确认')
  assert.match(html, /data-meeting-intent="decide"/, '缺少只决策选项')
  assert.match(html, /data-meeting-intent="execute"/, '缺少决策后可执行选项')
  assert.match(html, /result\.executionIntent\|\|lastMeetingExecutionIntent/, '只决策时没有隐藏执行批准')
  assert.match(html, /decision-no-execution/, '没有只决策状态说明')
  assert.match(html, /executionIntent:intent/, '启动请求没有持久化执行意图')
  assert.match(server, /executionIntent: meta\.executionIntent/, '历史 run 没有读取执行意图')
})

check('权限快捷面板覆盖档位、工具和作用域', () => {
  assert.match(html, /id="permPop"/, '缺少权限快捷面板')
  assert.match(html, /id="permPopScope"/, '缺少权限作用域')
  assert.match(html, /data-quick-tool="toolFiles"/, '缺少文件工具快捷开关')
  assert.match(html, /id="permToolsNote"/, '缺少模式限制说明')
  assert.match(html, /id="permAdvanced"/, '缺少详细设置入口')
})

check('Agent 工具轨迹能看见 diff、检查点和恢复入口', () => {
  assert.match(html, /id="agentCheckpoints"/, 'Agent 工具页没有检查点区域')
  assert.match(html, /function refreshCheckpoints\(/, '检查点没有真实读取绑定')
  assert.match(html, /data-cp-restore=/, '检查点没有恢复按钮')
  assert.match(html, /agent-diff/, 'Agent trace 没有 diff 展开区')
  assert.match(html, /agentStepHtml/, 'Agent trace 没有统一渲染 diff/检查点')
  assert.match(server, /\/api\/checkpoints/, '服务端没有检查点 API')
})

check('依据图谱可视化：SVG 支撑图 + 自动术语草稿 + supersedes', () => {
  assert.match(html, /ontology-graph/, '缺少图谱 SVG')
  assert.match(html, /role="img" aria-label="主张与决议的支撑关系图"/, '图谱没有可访问名称')
  assert.match(html, /ontology-term-label/, '缺少术语区')
  assert.match(html, /已认证.*草稿|草稿.*已认证/s, '术语没有草稿/已认证区分')
  assert.match(html, /ontology-supersedes/, '缺少取代关系展示')
  assert.match(html, /graph\.relations\.find\(row=>row\.type==='supersedes'\)/, '没有读取 supersedes 关系')
})

check('外部技能：官方市场可选启用，Agent 提示词按开关注入', () => {
  assert.match(html, /name:'anidoodle'[^\n]*external:true/, '缺少 anidoodle 官方外部技能条目')
  assert.match(html, /p\?\.external\)\{openPluginDetail\(p\);return\}/, '外部技能打开时没有走详情/安装面板')
  assert.match(html, /\/api\/skills\//, '缺少技能开关 API 调用')
  assert.match(html, /externalSkillToggle/, '缺少技能启用/停用按钮')
  assert.match(html, /外部技能说明/, '缺少外部技能风险说明')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /externalSkillRows/, '面板服务没有技能注册表')
  assert.match(server, /\/api\/skills/, '面板服务没有 /api/skills 路由')
  const agent = readFileSync(path.join(root, 'src', 'agent-runner.mjs'), 'utf8')
  assert.match(agent, /externalSkillsPrompt\(skills\)/, 'Agent 系统提示词没有按开关注入技能')
  const state = readFileSync(path.join(root, 'src', 'plugin-state.mjs'), 'utf8')
  assert.match(state, /id: 'anidoodle'[^\n]*defaultEnabled: false/, 'anidoodle 默认必须是关闭')
})

check('刷新续接：按本机 meeting id 重连，不重开会议', () => {
  assert.match(html, /LIVE_MEETING_KEY='heyi-live-meeting'/, '缺少本机续接游标')
  assert.match(html, /async function resumeLiveMeeting\(meeting\)/, '缺少续接函数')
  assert.match(html, /rememberLiveMeeting\(myMeetingId\)/, '启动会议后没有记录续接 id')
  assert.match(html, /data-live-resume=/, 'banner 没有逐场续接按钮')
  assert.match(html, /不会重新开始，也不会重复计费/, '缺少“不重开”的诚实说明')
  assert.match(html, /const stored=localStorage\.getItem\(LIVE_MEETING_KEY\)/, '刷新后没有读取续接游标')
  assert.match(html, /if\(target\)\{banner\.hidden=true;resumeLiveMeeting\(target\);return\}/, '刷新后没有自动续接')
})

check('历史决策书复用同一 renderer', () => {
  assert.match(html, /function historyDecisionResult\(data=\{\}\)/, '缺少历史结果归一化')
  assert.match(html, /decisionCoreHtml\(result,\{[\s\S]{0,220}?title:'主 Bot · 决策书（历史）'/, '历史决策书没有复用 decisionCoreHtml')
  assert.match(html, /decisionSummaryHtml\(data\.decision,data\.runDir,data\)/, '打开历史会话时没传完整会话数据')
  assert.match(html, /opts\.timeLabel\|\|new Date\(\)\.toLocaleString/, '历史决策书没有可覆盖的时间')
  assert.match(html, /历史记录[\s\S]{0,120}?运行中心/, '历史记录缺少执行状态指引')
})

check('执行前文件预演：只检查任务点名的路径', () => {
  assert.match(html, /approval-file-preview/, '审批卡没有文件预演容器')
  assert.match(html, /\/api\/decisions\/file-preview/, '没有调用文件预演 API')
  assert.match(html, /只检查任务里点名的路径/, '没有说明预演范围')
  assert.match(html, /不是执行 diff；不会读取文件内容/, '没有说明不是 diff、不读内容')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /previewPaths/, '服务端没有文件预演实现')
})

check('answerability 显式覆盖门禁', () => {
  assert.match(html, /answerability-gate/, '缺少覆盖不足确认块')
  assert.match(html, /answerabilityOverride/, '缺少显式覆盖勾选')
  assert.match(html, /会写进批准单和审计/, '缺少原因留痕说明')
  assert.match(html, /answerabilityLine\(info\)/, '审批卡没有依据覆盖行')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /ANSWERABILITY_REQUIRED/, '服务端没有覆盖不足门')
  assert.match(server, /includeDrafts: false/, '门禁不应把自动草稿算成依据')
  assert.match(server, /ANSWERABILITY_REASON_REQUIRED/, '缺少原因必填校验')
  assert.match(server, /executionAnswerability/, '执行入口没有复核覆盖门禁')
})

check('按会议存权限：本场模式受当前全局上限约束', () => {
  assert.match(html, /id="meetingPermission"/, '会议开始没有本场权限选择')
  assert.match(html, /permissionMode:lastMeetingPermissionMode/, '开始会议没有发送本场权限')
  assert.match(html, /function permissionLine\(info\)/, '审批卡没有本场权限行')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /mostRestrictiveMode/, '服务端没有权限收窄')
  assert.match(server, /decision-execution-scope/, '执行入口没有权限范围审计')
  const meeting = readFileSync(path.join(root, 'src', 'meeting.mjs'), 'utf8')
  assert.match(meeting, /permissionMode: String\(permissionMode/, '会议 meta 没有记录权限模式')
})

check('主 Bot 可选：默认匿名投票，指定后由指定模型收口', () => {
  assert.match(html, /id="nmForeman"/, '会议发起弹层没有主 Bot 选择')
  assert.match(html, /id="panelForeman"/, '模型面板没有主 Bot 选择')
  assert.match(html, /state\.settings\.foremanId/, '模型面板的主 Bot 选择没有状态来源')
  assert.match(html, /foremanId:quickForeman/, '开始会议没有发送指定主 Bot')
  assert.match(meeting, /FOREMAN_NOT_SELECTED/, '引擎没有拒绝不在场的主 Bot')
  assert.match(meeting, /foremanSelection = requestedForeman \? 'owner' : 'auto'/, '没有区分用户指定与自动选举')
  assert.match(meeting, /ownerSelectedForeman/, '决策提示没有区分用户指定的主 Bot')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /指定的主 Bot 必须在本场已选模型内/, '服务端没有校验主 Bot 范围')
})

check('副屏：第二显示器只读窗口，不抢主屏焦点', () => {
  assert.match(html, /id="companionBtn"/, '主界面没有副屏入口')
  assert.match(html, /#companionBtn\[hidden\][^{]*\{[^}]*display:none!important/, '副屏入口的 hidden 会被 display 样式覆盖')
  assert.match(html, /openCompanion/, '前端没有调用副屏 IPC')
  const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /displays-list/, '主进程没有显示器列表')
  assert.match(main, /showInactive/, '副屏会抢焦点')
  assert.match(main, /companion\.html|companionUrl/, '副屏没有只读页面')
  const preload = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  assert.match(preload, /getDisplays/, 'preload 没有显示器能力')
})

check('工作区权限可选文件夹并持久化', () => {
  assert.match(html, /id="workspaceRootPath"/, '权限页没有工作区路径')
  assert.match(html, /id="workspacePickDir"/, '权限页没有选择文件夹按钮')
  assert.match(html, /id="workspaceSetupModal"/, '首次启动没有工作区绑定门')
  assert.match(html, /workspaceBound/, '没有区分用户绑定与默认工作区')
  assert.match(html, /\/api\/permissions\/workspace/, '前端没有保存工作区根目录')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /setWorkspaceRoot/, '服务端没有工作区切换')
  const permissions = readFileSync(path.join(root, 'src', 'permissions.mjs'), 'utf8')
  assert.match(permissions, /workspaceRoot/, '权限状态没有保存工作区')
})

check('V1 版本与支持入口状态', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.0.0', 'V1 版本必须是 1.0.0')
  assert.match(html, /v1\.0\.0/, '界面静态版本没有同步 1.0.0')
  assert.doesNotMatch(html, /id="donateOpen"/, 'V1 支持入口必须关闭')
})

check('插件目录可手动刷新：版本/SHA/失败回退', () => {
  assert.match(html, /id="pluginCatalogRefresh"/, '插件市场没有刷新目录入口')
  assert.doesNotMatch(html, /\+\s*4\s*;/, '插件总数仍硬编码 +4')
  assert.match(html, /\+OFFICIAL_PLUGINS\.length/, '刷新后的官方插件计数没有使用同一份清单')
  assert.match(html, /\/api\/plugins\/catalog/, '没有读取当前目录 API')
  assert.match(html, /\/api\/plugins\/catalog\/refresh/, '没有刷新目录 API')
  const server = readFileSync(path.join(root, 'src', 'panel-server.mjs'), 'utf8')
  assert.match(server, /pluginCatalog\.refresh/, '服务端没有目录刷新')
  const catalog = readFileSync(path.join(root, 'src', 'plugin-catalog.mjs'), 'utf8')
  assert.match(catalog, /catalogUrl/, '缺少目录地址校验')
  assert.match(catalog, /sha256/, '缺少 SHA-256 校验')
  assert.match(catalog, /writeAtomic/, '缓存不是原子写入')
})

console.log('PASS UI contract (' + passed.length + ' checks)')
for (const name of passed) console.log('  - ' + name)
