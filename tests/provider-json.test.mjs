#!/usr/bin/env node
import assert from 'node:assert/strict'
import { extractJson } from '../src/providers.mjs'

assert.deepEqual(extractJson('{"action":"finish","answer":"ok"}'), { action: 'finish', answer: 'ok' })
assert.throws(() => extractJson('null'), /non-object|JSON|object/)
assert.throws(() => extractJson('[1,2]'), /non-object|JSON|object/)
console.log('PASS provider JSON rejects null/array payloads instead of TypeError')
