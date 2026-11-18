#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pythonRun } from '../src/tools.mjs'

const pythonBin = process.env.MEETINGBOT_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
if (spawnSync(pythonBin, ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('SKIP python sandbox: python not available')
  process.exit(0)
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-python-sandbox-'))
const permissions = {
  root,
  current: () => ({ id: 'self-review' }),
  assertPython: () => root,
  audit: () => {},
}
try {
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.writeFile(path.join(root, 'config', 'providers.vault.key'), 'not-readable\n', 'utf8')
  await fs.mkdir(path.join(root, 'state'), { recursive: true })
  await fs.writeFile(path.join(root, 'state', 'export-key.pem'), 'private-key\n', 'utf8')
  const fdPipe = await pythonRun({ permissions, code: 'import os, io\nr, w = os.pipe()\nio.open(r, "rb").close()\nio.open(w, "wb").close()\nprint("FD_OK")', cwd: root })
  assert.equal(fdPipe.ok, true)
  assert.match(fdPipe.stdout, /FD_OK/)
  const blockedSocket = await pythonRun({ permissions, code: 'import socket\nsocket.create_connection(("127.0.0.1", 9), timeout=1)', cwd: root })
  assert.equal(blockedSocket.ok, false)
  assert.match(blockedSocket.stderr, /network sockets are disabled|PermissionError/)
  const popen = await pythonRun({ permissions, code: 'import os\nprint(os.popen("echo hi").read())', cwd: root })
  assert.equal(popen.ok, false)
  assert.match(popen.stderr, /subprocess is disabled|PermissionError/)
  assert.doesNotMatch(popen.stderr, /TypeError/)
  const readVault = await pythonRun({ permissions, code: 'print(open(r"' + path.join(root, 'config', 'providers.vault.key') + '", "rb").read())', cwd: root })
  assert.equal(readVault.ok, false)
  assert.match(readVault.stderr, /vault files are not readable|PermissionError/)
  const bytesVault = await pythonRun({ permissions, code: 'print(open(os.fsencode(r"' + path.join(root, 'config', 'providers.vault.key') + '"), "rb").read())', cwd: root })
  assert.equal(bytesVault.ok, false)
  assert.match(bytesVault.stderr, /vault files are not readable|PermissionError/)

  // Regression for the P0 global-rebinding report: user code must not be able
  // to null out STRICT/PROTECTED or rewrite os.path.realpath and then read a
  // protected credential. Guard state lives in closures; user code runs in a
  // separate namespace.
  const rebound = await pythonRun({
    permissions,
    cwd: root,
    code: [
      'import os',
      'STRICT=False',
      'PROTECTED=set()',
      'PROTECTED_DIRS=set()',
      `os.path.realpath=lambda x: ${JSON.stringify(path.join(root, 'safe'))}`,
      `print(open(${JSON.stringify(path.join(root, 'config', 'providers.vault.key'))}).read())`,
    ].join('\n'),
  })
  assert.equal(rebound.ok, false, 'global rebinding bypassed the protected-file guard')
  assert.match(rebound.stderr, /protected|PermissionError/)
  const reboundNetwork = await pythonRun({
    permissions,
    cwd: root,
    code: 'STRICT=False\nPROTECTED=set()\nPROTECTED_DIRS=set()\nimport socket\nsocket.create_connection(("127.0.0.1", 9), timeout=1)',
  })
  assert.equal(reboundNetwork.ok, false, 'global rebinding bypassed the network guard')
  assert.match(reboundNetwork.stderr, /network sockets|PermissionError/)

  const quoted = path.join(root, "John's proj")
  await fs.mkdir(quoted, { recursive: true })
  const quotedPermissions = { ...permissions, root: quoted, assertPython: () => quoted }
  const quotedWrite = await pythonRun({ permissions: quotedPermissions, code: 'open("quoted.txt","w").write("ok")', cwd: quoted })
  assert.equal(quotedWrite.ok, true)
  assert.equal(await fs.readFile(path.join(quoted, 'quoted.txt'), 'utf8'), 'ok')

  const imports = await pythonRun({ permissions, code: 'import json, pathlib, zipfile, csv, argparse, shutil, glob, tempfile, textwrap, logging, string, base64, dataclasses, xml.etree.ElementTree, concurrent.futures\nprint("IMPORTS_OK")', cwd: root })
  assert.equal(imports.ok, true)
  assert.match(imports.stdout, /IMPORTS_OK/)
  const chinese = await pythonRun({ permissions, code: 'print("中文输出")', cwd: root })
  assert.equal(chinese.ok, true)
  assert.equal(chinese.stdout.trim(), '中文输出', 'Python -X utf8 must preserve Chinese output on non-UTF-8 Windows locales')
  const protectedStat = await pythonRun({ permissions, code: 'import os\nprint(os.path.exists(r"' + path.join(root, 'config', 'providers.vault.key') + '"))', cwd: root })
  assert.equal(protectedStat.ok, false)

  process.env.OPENAI_API_KEY = 'sk-openai-LEAKED-456'
  process.env.MEETINGBOT_VAULT_KEY = 'vault-master-passphrase-XYZ'
  const envRead = await pythonRun({ permissions, code: 'print("OPENAI_API_KEY" in os.environ, "MEETINGBOT_VAULT_KEY" in os.environ)', cwd: root })
  assert.equal(envRead.ok, true)
  assert.equal(envRead.stdout.trim(), 'False False')

  const exportRead = await pythonRun({ permissions, code: 'print(open(r"' + path.join(root, 'state', 'export-key.pem') + '").read())', cwd: root })
  assert.equal(exportRead.ok, false)
  const fullPermissions = { ...permissions, current: () => ({ id: 'full' }) }
  const fullVaultRead = await pythonRun({ permissions: fullPermissions, code: 'print(open(r"' + path.join(root, 'config', 'providers.vault.key') + '").read())', cwd: root })
  assert.equal(fullVaultRead.ok, false)

  console.log('PASS Python self-review sandbox protects vault and reads')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

