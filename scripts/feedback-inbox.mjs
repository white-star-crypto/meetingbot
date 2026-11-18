#!/usr/bin/env node
/* Standalone owner-only feedback inbox.
 *
 * This deliberately is NOT part of the product UI and is NOT served over HTTP.
 * It reads the local JSONL file directly, so only someone with access to this
 * machine and this checkout can see submitted feedback.
 *
 * Usage:
 *   node scripts/feedback-inbox.mjs
 *   node scripts/feedback-inbox.mjs --json
 *   node scripts/feedback-inbox.mjs --html
 *   node scripts/feedback-inbox.mjs --html --open
 *   node scripts/feedback-inbox.mjs --file E:\path\feedback.jsonl
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : ''
}
const asJson = args.includes('--json')
const asHtml = args.includes('--html')
const openAfter = args.includes('--open')
const explicit = getArg('--file')
const candidates = [
  explicit,
  path.resolve(process.cwd(), 'feedback', 'feedback.jsonl'),
  path.resolve(here, '..', 'feedback', 'feedback.jsonl'),
].filter(Boolean)
const file = candidates.find((p) => fs.existsSync(p)) || candidates[0]

function readItems () {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean).reverse()
}
const items = readItems()
const cats = { bug: 'Bug', idea: '建议', ui: '界面', other: '其他' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const stamp = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('zh-CN', { hour12: false })
}

if (asJson) {
  console.log(JSON.stringify({ file, count: items.length, items }, null, 2))
  process.exit(0)
}

if (asHtml) {
  const out = path.resolve(path.dirname(file), 'inbox.html')
  const cards = items.length ? items.map((item) => `
    <article>
      <header><b>${esc(cats[item.category] || item.category || '反馈')}</b><span>${item.source === 'agent' ? 'Agent' : '用户'}</span><time>${esc(stamp(item.at))}</time></header>
      <p>${esc(item.message)}</p>
      <small>${esc(item.id)}</small>
    </article>`).join('') : '<div class="empty">还没有反馈。</div>'
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>反馈收件箱</title>
<style>body{margin:0;padding:28px;background:#f5f4ef;color:#1e2329;font:14px/1.6 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}h1{font-size:20px;margin:0 0 4px}p.lead{color:#5f6a74;margin:0 0 20px}main{max-width:860px;margin:auto}article{background:#fff;border:1px solid #e5e3db;border-radius:10px;padding:12px 14px;margin:10px 0}header{display:flex;gap:10px;align-items:center;font-size:12px;color:#5f6a74}header b{color:#1e2329}header time{margin-left:auto;font-size:11px}article p{white-space:pre-wrap;overflow-wrap:anywhere}article small{color:#8a8f96;font-family:ui-monospace,Consolas,monospace}.empty{padding:30px;text-align:center;color:#5f6a74}</style>
<main><h1>反馈收件箱</h1><p class="lead">仅本机可见 · ${items.length} 条 · ${esc(file)}</p>${cards}</main></html>`, 'utf8')
  console.log(out)
  if (openAfter && process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref()
  }
  process.exit(0)
}

console.log(`收件箱：${file}`)
console.log(`共 ${items.length} 条`)
if (!items.length) process.exit(0)
for (const item of items) {
  console.log('\n' + '-'.repeat(72))
  console.log(`${stamp(item.at)}  ${item.source === 'agent' ? 'Agent' : '用户'}  ${cats[item.category] || item.category || '反馈'}`)
  console.log(String(item.message || '').trim())
  console.log(item.id || '')
}
