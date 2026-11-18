#!/usr/bin/env node
import assert from 'node:assert/strict'
import { assertPublicUrl } from '../src/tools.mjs'

const blocked = [
  'http://127.0.0.1/',
  'http://localhost/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0177.0.0.1/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
  'http://172.20.0.1/',
  'http://169.254.169.254/',
  'http://printer.local/',
  'http://user:pass@example.com/',
]

for (const url of blocked) {
  await assert.rejects(() => assertPublicUrl(url), undefined, `should block ${url}`)
}
console.log('PASS SSRF guard: numeric/octal IP, IPv4/IPv6 private, local names, credentials')
