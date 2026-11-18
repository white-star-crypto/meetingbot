#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts']
  : ['pack', '--dry-run', '--json', '--ignore-scripts']
const raw = execFileSync(npm, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
const result = JSON.parse(raw)[0]
const paths = new Set((result.files || []).map((entry) => entry.path.replace(/\\/g, '/')))
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const gitignorePath = path.join(root, '.gitignore')
const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
const gitignoreMissing = ['.gitignore', 'state/', 'config/providers.vault.key', '.env', 'feedback/', 'panel-screenshots/', 'release/']
  .filter((entry) => entry === '.gitignore' ? !fs.existsSync(gitignorePath) : !gitignore.split(/\r?\n/).includes(entry))
const brokenDocs = [...new Set([...readme.matchAll(/docs\/[A-Za-z0-9._/-]+\.md/g)].map((match) => match[0]))]
  .filter((file) => !paths.has(file))
const brokenReadmeRefs = [...new Set([...readme.matchAll(/(?:tests|examples|public)\/[A-Za-z0-9._/-]+\.(?:json|mjs|ico|png|md|js)(?![A-Za-z])/g)].map((match) => match[0]))]
  .filter((file) => !fs.existsSync(path.join(root, file)))
const required = [
  'README.md',
  'NOTICE.md',
  'LICENSE',
  'package.json',
  'bin/meetingbot.mjs',
  'src/meeting.mjs',
  'src/panel-server.mjs',
  'schemas/decision.schema.json',
  'public/panel.html',
  'public/heyi.ico',
  'public/dsh-plugins.json',
  'electron/main.cjs',
  'examples/config.example.json',
  'examples/brief.md',
  'launch-app.ps1',
  'MeetingBot.cmd',
  'tests/smoke.mjs',
  'tests/fixtures/mcp-server.mjs',
  'docs/MCP.md',
  'docs/APP-SHELL.md',
  'docs/PRIOR-ART.md',
  'docs/PROVIDERS.md',
  'docs/UX-ACCEPTANCE.md',
  'docs/UX-AUDIT-ROUND3.md',
]
const forbidden = [
  'meeting.config.local.json',
  'electron/startup.log',
  'state/',
  'runs/',
  'runs-live/',
  'feedback/',
  'panel-screenshots/',
  'release/',
  'node_modules/',
]
const missing = required.filter((file) => !paths.has(file))
const leaked = forbidden.filter((prefix) => [...paths].some((file) => file === prefix || file.startsWith(prefix)))
if (missing.length || leaked.length || brokenDocs.length || brokenReadmeRefs.length || gitignoreMissing.length) {
  console.error('pack check failed')
  if (missing.length) console.error('missing:', missing.join(', '))
  if (leaked.length) console.error('leaked:', leaked.join(', '))
  if (brokenDocs.length) console.error('README docs links missing from package:', brokenDocs.join(', '))
  if (gitignoreMissing.length) console.error('repository .gitignore missing entries:', gitignoreMissing.join(', '))
  if (brokenReadmeRefs.length) console.error('README references missing files:', brokenReadmeRefs.join(', '))
  process.exit(1)
}
console.log(`PASS package surface: ${paths.size} files; required present; no local state/logs`)
