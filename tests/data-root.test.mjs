#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveDataRoot } from '../src/data-root.mjs'

const previous = process.env.MEETINGBOT_DATA_DIR
try {
  delete process.env.MEETINGBOT_DATA_DIR
  assert.equal(resolveDataRoot(), path.resolve(process.cwd()))
  process.env.MEETINGBOT_DATA_DIR = path.join(process.cwd(), 'custom-data')
  assert.equal(resolveDataRoot(), path.resolve(process.cwd(), 'custom-data'))
  console.log('PASS data root resolves MEETINGBOT_DATA_DIR')
} finally {
  if (previous === undefined) delete process.env.MEETINGBOT_DATA_DIR
  else process.env.MEETINGBOT_DATA_DIR = previous
}
