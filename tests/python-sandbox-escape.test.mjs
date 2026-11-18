#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pythonRun } from '../src/tools.mjs'

const pythonBin = process.env.MEETINGBOT_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
if (spawnSync(pythonBin, ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('SKIP python escape: python not available')
  process.exit(0)
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-python-escape-'))
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-python-outside-'))
const permissions = { root, current: () => ({ id: 'self-review' }), assertPython: () => root, audit: () => {} }
try {
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep', 'utf8')
  if (process.platform !== "win32") {
    const write = await pythonRun({
      permissions,
      cwd: root,
      code: [
        'import os',
        `fd = os.open(r"${outside}", os.O_RDONLY)`,
        'try:',
        '    os.open("pwned.txt", os.O_CREAT | os.O_WRONLY, dir_fd=fd)',
        'except PermissionError:',
        '    print("DIRFD_WRITE_DENIED")',
      ].join('\n'),
    })
    if (!write.ok) console.error(write.stderr)
    assert.equal(write.ok, true)
    assert.match(write.stdout, /DIRFD_WRITE_DENIED/)
    assert.equal(await fs.stat(path.join(outside, 'pwned.txt')).catch(() => null), null)
  
    const unlink = await pythonRun({
      permissions,
      cwd: root,
      code: [
        'import os',
        `fd = os.open(r"${outside}", os.O_RDONLY)`,
        'try:',
        '    os.unlink("keep.txt", dir_fd=fd)',
        'except PermissionError:',
        '    print("DIRFD_UNLINK_DENIED")',
      ].join('\n'),
    })
    assert.equal(unlink.ok, true)
    assert.match(unlink.stdout, /DIRFD_UNLINK_DENIED/)
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  }
  if (process.platform === 'win32') {
    const startfile = await pythonRun({ permissions, cwd: root, code: 'import os\nos.startfile(r"C:\\\\Windows")' })
    assert.equal(startfile.ok, false)
  }
  console.log('PASS Python escape: dir_fd/startfile denied')
} finally {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
}

