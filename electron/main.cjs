const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
// Optional boot marker for packaging diagnostics. Off by default so a normal
// launch writes nothing outside the app's own data directory.
if (process.env.MEETINGBOT_BOOT_TRACE === '1') {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'meetingbot-boot.log'), `[${new Date().toISOString()}] main.cjs loaded pid=${process.pid}\n`) } catch {}
}
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session, screen } = require('electron')
const { sameOrigin, isHttpUrl } = require('./url-policy.cjs')

const root = path.resolve(__dirname, '..')
// A packaged app runs from app.asar, which is read-only. Writing startup.log
// next to main.cjs therefore failed silently in production; keep the log in a
// writable place instead so a failed boot can actually be diagnosed.
let logFile = ''
const log = (message) => {
  try {
    if (!logFile) {
      logFile = app.isPackaged ? path.join(app.getPath('userData'), 'startup.log') : path.join(__dirname, 'startup.log')
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
    }
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}
process.on('uncaughtException', (error) => log('uncaught: ' + (error?.stack || error)))
process.on('unhandledRejection', (error) => log('rejection: ' + (error?.stack || error)))

let mainWindow = null
let panel = null
let companionWindow = null


function displayList() {
  let primaryId = null
  try { primaryId = screen.getPrimaryDisplay().id } catch { /* before ready */ }
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: display.label || `显示器 ${index + 1}`,
    primary: display.id === primaryId,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }))
}

function pickSecondaryDisplay(displayId = '') {
  const displays = displayList()
  if (displayId) return displays.find((display) => display.id === String(displayId)) || null
  return displays.find((display) => !display.primary) || null
}

function companionUrl() {
  if (!panel?.url) return ''
  const url = new URL('/companion', panel.url)
  return url.toString()
}

function positionCompanion(display) {
  if (!companionWindow || companionWindow.isDestroyed() || !display) return
  const area = display.workArea || display.bounds
  const width = Math.min(1100, area.width)
  const height = Math.min(780, area.height)
  companionWindow.setBounds({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  })
}

function openCompanion(displayId = '') {
  if (!panel?.url) return { ok: false, error: '主程序还没准备好' }
  const display = pickSecondaryDisplay(displayId)
  if (!display) {
    return {
      ok: false,
      error: '没有检测到第二块显示器',
      displays: displayList(),
    }
  }
  if (companionWindow && !companionWindow.isDestroyed()) {
    positionCompanion(display)
    companionWindow.showInactive()
    return { ok: true, reused: true, display: { id: display.id, label: display.label } }
  }
  const area = display.workArea || display.bounds
  const width = Math.min(1100, area.width)
  const height = Math.min(780, area.height)
  companionWindow = new BrowserWindow({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
    minWidth: 560,
    minHeight: 420,
    show: false,
    frame: true,
    title: '合议 · 副屏',
    icon: path.join(root, 'public', 'heyi.ico'),
    backgroundColor: '#f6f5f1',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  companionWindow.setMenuBarVisibility(false)
  const denyPermissions = (_wc, _permission, callback) => callback(false)
  try { companionWindow.webContents.session.setPermissionRequestHandler(denyPermissions) } catch {}
  companionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  companionWindow.once('ready-to-show', () => {
    // Read-only companion: opening it must not take focus away from the user's
    // main screen. Clicking it still focuses normally.
    companionWindow.showInactive()
  })
  companionWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(panel.url).origin) event.preventDefault()
    } catch { event.preventDefault() }
  })
  companionWindow.on('closed', () => { companionWindow = null })
  companionWindow.loadURL(companionUrl()).catch((error) => log('companion load failed: ' + (error?.stack || error)))
  return { ok: true, reused: false, display: { id: display.id, label: display.label } }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (app.__meetingbotQuitting) return
  app.__meetingbotQuitting = true
  event.preventDefault()
  try {
    try {
      const { closeAllMcp } = await import('../src/mcp-client.mjs')
      await closeAllMcp()
    } catch (error) {
      log('mcp shutdown failed: ' + (error?.stack || error))
    }
    if (panel?.server) {
      try { panel.server.closeAllConnections?.() } catch { /* older Node */ }
      try { panel.server.closeIdleConnections?.() } catch { /* optional */ }
      await new Promise((resolve) => panel.server.close(() => resolve()))
    }
  } finally {
    app.quit()
  }
})

app.whenReady().then(bootstrap).catch((error) => {
  log('bootstrap failed: ' + (error?.stack || error))
  dialog.showErrorBox('合议 启动失败', String(error?.stack || error))
  app.quit()
})

function resolveConfigPath() {
  const fromArg = process.argv.find((arg) => arg.startsWith('--config='))
  if (fromArg) return path.resolve(fromArg.slice('--config='.length))
  if (process.env.MEETINGBOT_CONFIG) return path.resolve(process.env.MEETINGBOT_CONFIG)
  if (app.isPackaged) {
    const userConfig = path.join(app.getPath('userData'), 'meeting.config.json')
    if (!fs.existsSync(userConfig)) {
      const example = path.join(root, 'examples', 'config.example.json')
      if (fs.existsSync(example)) fs.copyFileSync(example, userConfig)
    }
    return userConfig
  }
  return path.join(root, 'meeting.config.local.json')
}

async function bootstrap() {
  log('bootstrap start')
  const configPath = resolveConfigPath()
  log('config=' + configPath)
  if (!fs.existsSync(configPath)) {
    dialog.showErrorBox('MeetingBot', `找不到配置文件：\n${configPath}\n\n请用 --config=路径 启动。`)
    app.quit()
    return
  }

  if (app.isPackaged && !process.env.MEETINGBOT_DATA_DIR) process.env.MEETINGBOT_DATA_DIR = app.getPath('userData')
  const { startPanel } = await import('../src/panel-server.mjs')
  panel = await startPanel({ configPath, port: 0 })
  log('panel listening: ' + panel.url)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 560,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    title: '合议',
    icon: path.join(root, 'public', 'heyi.ico'),
    backgroundColor: '#f4f5f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  Menu.setApplicationMenu(null)
  mainWindow.setMenuBarVisibility(false)
  const allowNav = (url) => /^(https?:|about:blank)/i.test(url)
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!allowNav(params.src || '')) event.preventDefault()
  })
  const denyPermissions = (_wc, _permission, callback) => callback(false)
  try { mainWindow.webContents.session.setPermissionRequestHandler(denyPermissions) } catch {}
  try {
    const toolSession = session.fromPartition('persist:heyi-tools')
    toolSession.setPermissionRequestHandler(denyPermissions)
    // loadURL(file://) bypasses will-navigate; block at the session layer too.
    toolSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !/^https?:\/\//i.test(details.url) })
    })
  } catch {}
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => { if (!allowNav(url)) event.preventDefault() })
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
  ipcMain.on('window-control', (_event, action) => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'toggle-maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
  })
  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('invalid external url')
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle('pick-directory', async () => {
    if (!mainWindow) throw new Error('window is not ready')
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })
  ipcMain.handle('displays-list', () => displayList())
  ipcMain.handle('companion-open', (_event, displayId) => openCompanion(String(displayId || '')))
  ipcMain.handle('companion-close', () => {
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.close()
    return { ok: true }
  })
  ipcMain.handle('companion-status', () => ({
    open: !!(companionWindow && !companionWindow.isDestroyed()),
    displays: displayList(),
  }))
  screen.on('display-removed', () => {
    if (!companionWindow || companionWindow.isDestroyed()) return
    if (!pickSecondaryDisplay()) companionWindow.close()
    else positionCompanion(pickSecondaryDisplay())
  })
  screen.on('display-metrics-changed', () => {
    if (!companionWindow || companionWindow.isDestroyed()) return
    positionCompanion(pickSecondaryDisplay())
  })
  // Whitelisted, read-only "open in OS" action. No arbitrary paths cross the
  // renderer boundary; everything resolves inside the application directory.
  ipcMain.handle('open-path', async (_event, kind) => {
    const dataRoot = path.resolve(process.env.MEETINGBOT_DATA_DIR || (app.isPackaged ? app.getPath('userData') : root))
    const targets = {
      state: path.join(dataRoot, 'state'),
      audit: path.join(dataRoot, 'state', 'audit.jsonl'),
      runs: path.resolve(process.cwd(), 'runs-live'),
      config: path.join(dataRoot, 'config'),
    }
    const target = targets[String(kind)]
    if (!target) return { ok: false, error: 'unknown path key' }
    const absolute = path.resolve(target)
    const base = path.resolve(kind === 'runs' ? process.cwd() : dataRoot)
    if (absolute !== base && !absolute.startsWith(base + path.sep)) {
      return { ok: false, error: 'path outside application data directory' }
    }
    try {
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    } catch { /* a missing file is reported by shell.openPath */ }
    const error = await shell.openPath(absolute)
    return { ok: !error, error: error || '' }
  })
  ipcMain.handle('capture-window', async () => {
    if (!mainWindow) throw new Error('window is not ready')
    const image = await mainWindow.webContents.capturePage()
    const dataRoot = path.resolve(process.env.MEETINGBOT_DATA_DIR || (app.isPackaged ? app.getPath('userData') : root))
    const dir = path.join(dataRoot, 'state', 'captures')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `window-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const buffer = image.toPNG()
    fs.writeFileSync(file, buffer)
    return {
      ok: true,
      path: file,
      width: image.getSize().width,
      height: image.getSize().height,
      dataUrl: 'data:image/png;base64,' + buffer.toString('base64'),
    }
  })
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log('renderer console: ' + message)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`did-fail-load ${code} ${description} ${url}`)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Compare parsed origins, never string prefixes. A URL such as
    // http://127.0.0.1:1@evil.example/ has the prefix but a different origin.
    if (sameOrigin(url, panel.url)) return { action: 'allow' }
    if (isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, panel.url)) event.preventDefault()
  })
  await mainWindow.loadURL(panel.url)
  log('window loaded')
}
