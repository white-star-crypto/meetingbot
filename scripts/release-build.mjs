#!/usr/bin/env node
// Clean release build. Verifies the packaged asar AFTER building, because a
// build that runs concurrently with tests once produced an asar whose
// package.json was concatenated with an example brief. Run this as the only
// build/test process.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDir = path.join(root, 'release')
const appDir = path.join(releaseDir, 'win-unpacked')
const asarPath = path.join(appDir, 'resources', 'app.asar')
const zipPath = path.join(releaseDir, `meetingbot-${version}-portable.zip`)
const run = (command, options = {}) => {
  console.log('> ' + command)
  execSync(command, { cwd: root, stdio: 'inherit', ...options })
}
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const buildEnv = {
  ...process.env,
  // GitHub's Electron download can time out from this machine; point the
  // mirror at npmmirror and, more importantly, package the local runtime.
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
}

console.log(`release-build: meetingbot v${version}`)

// 0. Preflight: the panel and the package must name the same version.
const panel = fs.readFileSync(path.join(root, 'public', 'panel.html'), 'utf8')
if (!panel.includes(`v${version}`)) {
  console.error(`PRECHECK FAIL: public/panel.html does not carry v${version}`)
  process.exit(1)
}
if (!fs.existsSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
  console.error('PRECHECK FAIL: electron runtime missing under node_modules/electron/dist')
  process.exit(1)
}

// 1. Build the unpacked app. electronDist makes the step offline: the local
//    node_modules runtime is copied instead of re-downloading Electron.
run(
  `npx electron-builder --win dir --config.directories.output=release --config.electronDist="${electronDist}"`,
  { env: buildEnv },
)

// 2. Verify the archive we just produced (this is the step that caught the
//    corrupted package.json last time).
if (!fs.existsSync(asarPath)) {
  console.error('VERIFY FAIL: resources/app.asar missing')
  process.exit(1)
}
const asar = require('@electron/asar')
let packed
try {
  packed = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
} catch (error) {
  console.error('VERIFY FAIL: packaged package.json is not valid JSON — ' + error.message)
  console.error('Do not ship this build. Rebuild with no tests running.')
  process.exit(1)
}
if (packed.version !== version) {
  console.error(`VERIFY FAIL: asar version ${packed.version} != package.json ${version}`)
  process.exit(1)
}
if (!packed.main) {
  console.error('VERIFY FAIL: packaged package.json has no main entry')
  process.exit(1)
}
if (!fs.existsSync(path.join(appDir, 'resources', 'app.asar'))) {
  console.error('VERIFY FAIL: app.asar vanished during verification')
  process.exit(1)
}
const packedPanel = asar.extractFile(asarPath, 'public/panel.html').toString('utf8')
for (const token of [`v${version}`, 'decisionCoreHtml', 'mp-person', 'mp-tok', 'ontology-card', 'ontology-graph', 'single-starters', 'externalSkillToggle', 'resumeLiveMeeting', 'LIVE_MEETING_KEY']) {
  if (!packedPanel.includes(token)) {
    console.error(`VERIFY FAIL: packaged panel is missing ${token}`)
    process.exit(1)
  }
}
const packedMeeting = asar.extractFile(asarPath, 'src/meeting.mjs').toString('utf8')
if (!packedMeeting.includes('onParticipant')) {
  console.error('VERIFY FAIL: packaged engine has no participant channel')
  process.exit(1)
}
// 2.3.1 features must be inside the archive, not only in the source tree.
const packedServer = asar.extractFile(asarPath, 'src/panel-server.mjs').toString('utf8')
for (const token of ['/api/ontology/ingest', '/api/meetings/live', 'live-runs.json', '/api/skills', 'brief: brief.slice']) {
  if (!packedServer.includes(token)) {
    console.error(`VERIFY FAIL: packaged server is missing ${token}`)
    process.exit(1)
  }
}
const packedTools = asar.extractFile(asarPath, 'src/tools.mjs').toString('utf8')
if (!packedTools.includes('SCOPE_DENIED')) {
  console.error('VERIFY FAIL: packaged tools have no approval path whitelist')
  process.exit(1)
}
const packedApproval = asar.extractFile(asarPath, 'src/decision-approval.mjs').toString('utf8')
if (!packedApproval.includes('allowedPaths')) {
  console.error('VERIFY FAIL: packaged approval is missing allowedPaths')
  process.exit(1)
}
const packedFiles = asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/'))
for (const moduleName of ['decision-ontology.mjs', 'checkpoints.mjs', 'external-skills.mjs']) {
  if (!packedFiles.some((entry) => entry.endsWith('/src/' + moduleName))) {
    console.error(`VERIFY FAIL: packaged archive is missing src/${moduleName}`)
    process.exit(1)
  }
}
const packedAgent = asar.extractFile(asarPath, 'src/agent-runner.mjs').toString('utf8')
if (!packedAgent.includes('externalSkillsPrompt')) {
  console.error('VERIFY FAIL: packaged agent cannot inject external skills')
  process.exit(1)
}
const packedPluginState = asar.extractFile(asarPath, 'src/plugin-state.mjs').toString('utf8')
if (!packedPluginState.includes('anidoodle')) {
  console.error('VERIFY FAIL: packaged plugin state has no anidoodle entry')
  process.exit(1)
}
console.log(`VERIFY OK: asar v${packed.version} · main ${packed.main} · ontology/approval/live-runs/unslop/external-skill present`)

// 3. Portable ZIP of the unpacked app (exe at the archive root). Use bsdtar:
//    PowerShell 5.1's Compress-Archive writes backslash entry names, which
//    most non-Windows unzip tools cannot read (packguard flags it).
if (fs.existsSync(zipPath)) fs.rmSync(zipPath)
run(`tar.exe -a -c -f "${zipPath}" -C "${appDir}" .`)
if (!fs.existsSync(zipPath)) {
  console.error('VERIFY FAIL: portable zip was not created')
  process.exit(1)
}
// Optional local gate: set PACKGUARD_BIN to a packguard CLI. Repository and
// portable builds must not depend on a contributor's machine layout.
const packguard = process.env.PACKGUARD_BIN || ''
if (packguard && fs.existsSync(packguard)) {
  run(`node "${packguard}" "${zipPath}"`)
} else {
  console.log('note: packguard not configured (set PACKGUARD_BIN); skipped the ZIP entry-name gate')
}

// 4. npm package tarball.
run('npm pack --silent')
const tgz = path.join(root, `meetingbot-${version}.tgz`)
if (fs.existsSync(tgz)) fs.renameSync(tgz, path.join(releaseDir, `meetingbot-${version}.tgz`))

// 5. Checksums. This project ships unsigned by design (solo open-source
//    maintainer); a hash file is the honest substitute for "verify the file",
//    without pretending to be a code-signing identity.
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sums = [
  [zipPath, path.basename(zipPath)],
  [path.join(releaseDir, `meetingbot-${version}.tgz`), `meetingbot-${version}.tgz`],
  [path.join(appDir, '合议.exe'), 'win-unpacked/合议.exe'],
].filter(([file]) => fs.existsSync(file))
fs.writeFileSync(
  path.join(releaseDir, 'SHA256SUMS.txt'),
  sums.map(([file, label]) => `${sha256(file)}  ${label}`).join('\n') + '\n',
  'utf8',
)

const size = (file) => fs.existsSync(file) ? (fs.statSync(file).size / 1048576).toFixed(1) + ' MB' : 'MISSING'
console.log('ARTIFACTS')
console.log(`  ${path.basename(asarPath)}                 ${size(asarPath)}`)
console.log(`  ${path.basename(zipPath)}   ${size(zipPath)}`)
console.log(`  meetingbot-${version}.tgz                    ${size(path.join(releaseDir, `meetingbot-${version}.tgz`))}`)
console.log(`  SHA256SUMS.txt                             ${sums.length} hashes`)
if (size(zipPath) === 'MISSING') process.exit(1)
console.log('DONE')
