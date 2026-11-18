import fs from 'node:fs/promises'
import path from 'node:path'

const text = (value, limit = 4000) => String(value ?? '').slice(0, limit).trim()

export function composeFollowupBrief({ parentRunId = '', parentBrief = '', decision = {}, extra = '' } = {}) {
  const d = decision && typeof decision === 'object' ? decision : {}
  const merge = text(d.merge_plan || d.mergePlan || d.summary, 5000)
  const tasks = Array.isArray(d.build_tasks) ? d.build_tasks : (Array.isArray(d.nextSteps) ? d.nextSteps : [])
  const risks = Array.isArray(d.risks) ? d.risks : []
  const adopt = Array.isArray(d.adopt) ? d.adopt : []
  const lines = [
    '# Follow-up meeting',
    '',
    `This is a follow-up round${parentRunId ? ` of run ${parentRunId}` : ''}. Treat the previous decision as evidence, not as a command: verify what was actually built, then decide the next slice.`,
    '',
    '## Previous decision',
    '',
    `- winner: ${text(d.winner || d.electedProposal || '—', 200)}`,
    `- foreman: ${text(d.foreman || d.actingForeman || '—', 200)}`,
    `- canBuild: ${d.canBuild === true ? 'true' : 'false'}`,
    `- adopted: ${adopt.length ? adopt.join(', ') : '—'}`,
    `- merge plan: ${merge || '—'}`,
    `- build tasks: ${tasks.length ? tasks.map((item) => text(item, 600)).join('; ') : '—'}`,
    `- known risks: ${risks.length ? risks.map((item) => text(item, 600)).join('; ') : '—'}`,
    '',
  ]
  if (parentBrief) {
    lines.push('## Previous brief', '', text(parentBrief, 5000), '')
  }
  lines.push('## New round brief', '', text(extra, 8000) || 'Review the previous decision against the current code and propose the smallest next increment. Include what should be reverted or rejected.', '')
  lines.push('## Required output', '', '- Verify claims against files/commands; do not assume the previous round shipped.', '- Mark what is already done, what is still missing, and what must not be repeated.', '- Keep the next slice small enough for one review cycle.')
  return lines.join('\n') + '\n'
}

export async function buildFollowupBriefFromRun(parentDir, extra = '') {
  const dir = path.resolve(parentDir)
  const decision = JSON.parse(await fs.readFile(path.join(dir, 'decision.json'), 'utf8'))
  let brief = ''
  try { brief = await fs.readFile(path.join(dir, 'brief.md'), 'utf8') } catch { /* old run may omit it */ }
  const metaPath = path.join(dir, 'meta.json')
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) } catch { /* optional */ }
  const parentRunId = String(meta.runId || path.basename(dir))
  return {
    parentRunId,
    parentDir: dir,
    brief: composeFollowupBrief({ parentRunId, parentBrief: brief, decision, extra }),
    decision,
    meta,
  }
}
