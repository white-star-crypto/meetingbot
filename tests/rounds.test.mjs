#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildFollowupBriefFromRun, composeFollowupBrief } from '../src/rounds.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-rounds-'))
try {
  await fs.writeFile(path.join(tmp, 'decision.json'), JSON.stringify({
    winner: 'P2',
    foreman: 'alpha',
    canBuild: false,
    adopt: ['P2', 'P1'],
    merge_plan: 'Use P2 skeleton, keep P1 spacing.',
    build_tasks: ['wire adapter', 'add empty state'],
    risks: ['adapter may leak'],
  }), 'utf8')
  await fs.writeFile(path.join(tmp, 'brief.md'), '# Original\n\nBuild the bridge.', 'utf8')
  await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify({ runId: 'run-parent' }), 'utf8')

  const built = await buildFollowupBriefFromRun(tmp, 'Now verify the adapter with a real fixture.')
  assert.equal(built.parentRunId, 'run-parent')
  assert.match(built.brief, /Follow-up meeting/)
  assert.match(built.brief, /run-parent/)
  assert.match(built.brief, /Use P2 skeleton/)
  assert.match(built.brief, /wire adapter/)
  assert.match(built.brief, /Now verify the adapter/)
  assert.match(built.brief, /Verify claims against files/)

  const composed = composeFollowupBrief({ parentRunId: 'x', decision: { build_tasks: ['t1'] } })
  assert.match(composed, /t1/)
  assert.match(composed, /not as a command/)
  console.log('PASS follow-up brief composition and parent run lineage')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
