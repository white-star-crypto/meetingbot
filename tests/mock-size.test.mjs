#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runMeeting } from '../src/meeting.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-mock-size-'))
try {
  const base = JSON.parse(await fs.readFile('examples/config.mock.json', 'utf8'))
  await fs.writeFile(path.join(dir, 'brief.md'), 'mock size test\n', 'utf8')
  const run = async (count) => {
    const config = {
      ...base,
      selection: { ...base.selection, count },
      roster: Array.from({ length: count }, (_, i) => ({ ...base.roster[i % base.roster.length], id: `m${i}`, label: `Model ${i}` })),
    }
    const configPath = path.join(dir, `config-${count}.json`)
    await fs.writeFile(configPath, JSON.stringify(config), 'utf8')
    return runMeeting({ briefPath: path.join(dir, 'brief.md'), configPath, outDir: path.join(dir, `runs-${count}`), mock: true })
  }

  for (const count of [2, 3, 4, 6]) {
    const result = await run(count)
    assert.ok(result.decision.winner, `count ${count}: winner missing`)
    assert.ok(result.decision.adopt.includes(result.decision.winner), `count ${count}: winner not adopted`)
    const vote = JSON.parse(await fs.readFile(path.join(result.runDir, 'votes.json'), 'utf8'))
    assert.ok(vote.rows.length >= 1)
  }

  await assert.rejects(
    () => runMeeting({ briefPath: path.join(dir, 'brief.md'), outDir: path.join(dir, 'missing-config'), mock: true }),
    /configPath is required/,
  )
  console.log('PASS mock roster sizes 2/3/4/6 and missing configPath fail clearly')
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
