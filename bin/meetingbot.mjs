#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs/promises'
import { runMeeting, repairDecision } from '../src/meeting.mjs'
import { loadConfig, publicRoster } from '../src/config.mjs'
import { callChat } from '../src/providers.mjs'
import { tally } from '../src/tally.mjs'
import { startPanel } from '../src/panel-server.mjs'
import { askSingle } from '../src/single.mjs'
import { runBuildGate } from '../src/build-gate.mjs'
import { writePrReviewBrief } from '../src/pr-review.mjs'
import { validateDecisionDocument } from '../src/decision-schema.mjs'
import { exportRun, verifyBundle, replayBundle } from '../src/bundle.mjs'
import { rotateMaster } from '../src/key-vault.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name)
  const next = i >= 0 ? argv[i + 1] : ''
  return next && !String(next).startsWith('-') ? next : fallback
}
const has = (name) => argv.includes(name)
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
const wantsJson = has('--json')
const numberArg = (name) => {
  const raw = arg(name)
  if (raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`MeetingBot v${pkg.version} — multi-model design meeting (meeting only)

Usage:
  node bin/meetingbot.mjs start --brief examples/brief.md --config examples/config.mock.json --mock [--mock-slow 0.3] [--mock-size 12] [--no-cache] [--json]
  node bin/meetingbot.mjs start --brief examples/brief.md --config meeting.config.json --agents deepseek,glm,qwen --count 3
  node bin/meetingbot.mjs presets list --config meeting.config.json
  node bin/meetingbot.mjs start --brief examples/brief.md --config meeting.config.json --preset one
  node bin/meetingbot.mjs providers list --config meeting.config.json
  node bin/meetingbot.mjs providers add --config meeting.config.json --id kimi --label Kimi --base-url https://api.moonshot.cn/v1 --model kimi-k2.7-code --api-key-env KIMI_API_KEY --tags code,long-context --cost-tier 3
  node bin/meetingbot.mjs providers test --config meeting.config.json --id deepseek
  node bin/meetingbot.mjs replay runs/<timestamp>
  node bin/meetingbot.mjs repair <run-dir> [--timeout-ms 600000]
  node bin/meetingbot.mjs gate <run-dir> [--command "npm test"] [--timeout-ms 300000] [--json]
  node bin/meetingbot.mjs validate --config meeting.config.json [--json]
  node bin/meetingbot.mjs pr-review --repo . --base main --head HEAD --out pr-review-brief.md [--json]
  node bin/meetingbot.mjs keys rotate
  node bin/meetingbot.mjs verify <run-dir> [--json]
  node bin/meetingbot.mjs export <run-dir> [--out bundle.json] [--json]
  node bin/meetingbot.mjs verify-bundle <bundle.json> [--public-key pem] [--json]
  node bin/meetingbot.mjs panel --config meeting.config.json [--port 4318] [--host 127.0.0.1] [--token secret] [--tls-cert cert.pem --tls-key key.pem] [--tls-pfx cert.pfx --tls-passphrase ...] [--allow-insecure]
  node bin/meetingbot.mjs replay-bundle <bundle.json> [--public-key pem] [--json]
  node bin/meetingbot.mjs panel --config meeting.config.json --port 4318
  node bin/meetingbot.mjs ask --config meeting.config.json --agent deepseek --prompt "解释这个方案的风险"
  node bin/meetingbot.mjs show <run-dir>
  node bin/meetingbot.mjs list [runs-dir]

Selection:
  --agents a,b,c      explicit attendees (must exist and be enabled)
  --count N           target attendee count (default: config.selection.count)
  --exclude a,b       remove agents
  --require-tags x,y  only agents with all tags
  --max-cost-tier N   1=cheap .. 5=expensive
  --preset NAME       apply a named preset (agents/count/thinking)
`)
    return
  }

  if (cmd === 'presets') {
    const sub = argv[1] || 'list'
    const configPath = arg('--config')
    if (!configPath) throw new Error('presets requires --config')
    if (sub !== 'list') throw new Error('unknown presets command: ' + sub)
    const config = loadConfig(configPath, { requireKeys: false })
    for (const [name, preset] of Object.entries(config.presets)) {
      console.log(`${name}\t${preset.label || name}\tagents=${(preset.agents || []).join(',')}\tcount=${preset.count || config.selection.count}\tthinking=${preset.thinking || 'default'}`)
    }
    return
  }

  if (cmd === 'validate') {
    const configPath = arg('--config')
    if (!configPath) throw new Error('validate requires --config')
    const config = loadConfig(configPath, { requireKeys: false })
    const enabled = config.participants.filter((p) => p.enabled !== false)
    const summary = {
      ok: true,
      config: path.resolve(configPath),
      participants: config.participants.length,
      enabled: enabled.length,
      withKey: enabled.filter((p) => p.hasKey).length,
      presets: Object.keys(config.presets || {}),
      defaultPreset: config.selection.defaultPreset || '',
      selectionCount: config.selection.count,
      quorumMin: config.quorum.min,
      buildGate: {
        required: config.buildGate?.required === true,
        commands: config.buildGate?.commands || [],
        cwd: config.buildGate?.cwd || '',
      },
      mcp: { enabled: config.mcp?.enabled === true, servers: config.mcp?.servers?.length || 0 },
      cache: { enabled: config.cache?.enabled !== false, ttlDays: config.cache?.ttlDays || 7, dir: config.cache?.dir || 'state/cache' },
      roster: enabled.map((p) => ({ id: p.id, label: p.label, model: p.model, hasKey: p.hasKey })),
    }
    if (wantsJson) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log(`Config OK: ${summary.config}`)
      console.log(`Participants: ${summary.enabled}/${summary.participants} enabled, ${summary.withKey} with key`)
      console.log(`Default preset: ${summary.defaultPreset || 'none'} · selection=${summary.selectionCount} · quorum=${summary.quorumMin}`)
      console.log(`Build gate: ${summary.buildGate.required ? 'required' : 'not required'} · commands=${summary.buildGate.commands.length}`)
      console.log(`MCP: ${summary.mcp.enabled ? 'enabled' : 'disabled'} · servers=${summary.mcp.servers}`)
      console.log(`Cache: ${summary.cache.enabled ? 'enabled' : 'disabled'} · ${summary.cache.dir} · ttl=${summary.cache.ttlDays}d`)
    }
    return
  }

  if (cmd === 'start') {
    const brief = arg('--brief')
    const config = arg('--config')
    if (!brief || !config) throw new Error('start requires --brief and --config')
    const result = await runMeeting({
      briefPath: brief,
      configPath: config,
      outDir: arg('--out', ''),
      mock: has('--mock'),
      mockDelayMs: Math.round((Number(arg('--mock-slow')) || 0) * 1000),
      mockSize: Number(arg('--mock-size')) || 0,
      cache: !has('--no-cache'),
      selection: {
        agents: list(arg('--agents')),
        count: numberArg('--count'),
        exclude: list(arg('--exclude')),
        requireTags: list(arg('--require-tags')),
        maxCostTier: numberArg('--max-cost-tier'),
        preset: arg('--preset', ''),
      },
    })
    if (wantsJson) {
      console.log(JSON.stringify({
        schema: 'meetingbot/cli/start/v1',
        ok: true,
        runDir: result.runDir,
        winnerId: result.winnerId,
        foreman: result.foreman ? {
          id: result.foreman.id,
          label: result.foreman.label,
          model: result.foreman.model,
          provider: result.foreman.provider,
        } : null,
        canBuild: result.canBuild === true,
        parentRunId: result.parentRunId || null,
        cache: result.cache || null,
        fallback: result.decision?.fallback === true,
        failover: result.decision?.failover === true,
        ownerGate: result.decision?.ownerGate === true,
        decisionPath: path.join(result.runDir, 'decision.json'),
        markdownPath: path.join(result.runDir, 'decision.md'),
        htmlPath: path.join(result.runDir, 'report.html'),
      }, null, 2))
    } else {
      console.log(`Meeting complete: ${result.runDir}`)
      console.log(`Foreman: ${result.winnerId} / ${result.foreman?.label || 'none — owner review required'}`)
      console.log(`Decision: ${path.join(result.runDir, 'decision.md')}`)
      console.log(`HTML: ${path.join(result.runDir, 'report.html')}`)
    }
    return
  }

  if (cmd === 'providers') {
    const sub = argv[1] || 'list'
    const configPath = arg('--config')
    if (!configPath) throw new Error('providers requires --config')
    if (sub === 'list') {
      const config = loadConfig(configPath, { requireKeys: false })
      for (const p of publicRoster(config)) {
        console.log(`${p.id}\t${p.label}\t${p.model}\ttags=${p.tags.join(',') || '-'}\tcost=${p.costTier}\tquality=${p.qualityTier}\tenabled=${p.enabled}`)
      }
      return
    }
    if (sub === 'add') {
      const id = String(arg('--id')).trim()
      const label = String(arg('--label') || id).trim()
      const baseUrl = String(arg('--base-url')).trim()
      const model = String(arg('--model')).trim()
      if (!id || !baseUrl || !model) throw new Error('providers add requires --id --base-url --model')
      const raw = await readJson(configPath)
      const rosterKey = Array.isArray(raw.roster) ? 'roster' : (Array.isArray(raw.participants) ? 'participants' : 'roster')
      const roster = Array.isArray(raw[rosterKey]) ? raw[rosterKey] : []
      if (roster.some((p) => p.id === id)) throw new Error('provider id already exists: ' + id)
      const entry = {
        id,
        label,
        provider: 'openai',
        baseUrl,
        model,
        enabled: true,
        tags: list(arg('--tags')),
        costTier: Math.max(1, Math.min(5, Number(arg('--cost-tier')) || 3)),
        qualityTier: Math.max(1, Math.min(5, Number(arg('--quality-tier')) || 3)),
        family: String(arg('--family') || 'openai'),
      }
      if (arg('--api-key-env')) entry.apiKeyEnv = arg('--api-key-env')
      else if (arg('--api-key-file')) entry.apiKeyFile = arg('--api-key-file')
      else throw new Error('providers add requires --api-key-env or --api-key-file')
      roster.push(entry)
      raw[rosterKey] = roster
      await fs.writeFile(path.resolve(configPath), JSON.stringify(raw, null, 2) + '\n', 'utf8')
      console.log(`Added provider ${id}: ${baseUrl} / ${model}`)
      return
    }
    if (sub === 'test') {
      const id = arg('--id')
      if (!id) throw new Error('providers test requires --id')
      const config = loadConfig(configPath, { requireKeys: true })
      const participant = config.participants.find((p) => p.id === id)
      if (!participant) throw new Error('provider not found: ' + id)
      const result = await callChat(participant, [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ], { maxTokens: 16, temperature: 0, timeoutMs: 30000 })
      console.log(`OK ${participant.id} ${participant.model} ${result.durationMs}ms`)
      return
    }
    throw new Error('unknown providers command: ' + sub)
  }

  if (cmd === 'replay') {
    const dir = argv[1]
    if (!dir) throw new Error('replay requires a run directory')
    const runDir = path.resolve(dir)
    const proposalDir = path.join(runDir, 'proposals')
    const names = (await fs.readdir(proposalDir)).filter((name) => /^P\d+\.json$/.test(name)).sort()
    const proposals = []
    for (const name of names) proposals.push(JSON.parse(await fs.readFile(path.join(proposalDir, name), 'utf8')))
    const votes = JSON.parse(await fs.readFile(path.join(runDir, 'votes.json'), 'utf8'))
    let savedAudit = null
    try { savedAudit = JSON.parse(await fs.readFile(path.join(runDir, 'tally-audit.json'), 'utf8')) } catch { /* older runs may not have it */ }
    const options = {
      dimensionWeights: savedAudit?.dimensionWeights || votes.tallyAudit?.dimensionWeights,
      selfScorePolicy: savedAudit?.selfScorePolicy || votes.tallyAudit?.selfScorePolicy,
      selfScoreWeight: savedAudit?.selfScoreWeight ?? votes.tallyAudit?.selfScoreWeight,
      stripSelfFromRanking: savedAudit?.stripSelfFromRanking ?? votes.tallyAudit?.stripSelfFromRanking,
      voterTagBoost: savedAudit?.voterTagBoost ?? votes.tallyAudit?.voterTagBoost,
    }
    const result = tally(proposals, votes.rows || [], options)
    const expectedWinner = savedAudit?.winner || votes.tallyAudit?.winner || votes.winner || null
    const matches = !expectedWinner || result.winnerId === expectedWinner
    const replay = { ...result, expectedWinner, matches }
    await fs.writeFile(path.join(runDir, 'tally-replay.json'), JSON.stringify(replay, null, 2) + '\n', 'utf8')
    console.log(`Replay winner: ${result.winnerId}`)
    console.log(`Saved winner: ${expectedWinner || 'not recorded'}`)
    console.log(`Method: ${result.audit.method}`)
    console.log(`Audit: ${path.join(runDir, 'tally-replay.json')}`)
    if (!matches) {
      const line = `MISMATCH: replay=${result.winnerId} saved=${expectedWinner}`
      console.error(process.stdout.isTTY ? `\x1b[31m${line}\x1b[0m` : line)
      process.exitCode = 1
    }
    return
  }

  if (cmd === 'gate') {
    const runDir = argv[1]
    if (!runDir) throw new Error('gate requires <run-dir>')
    const decision = JSON.parse(await fs.readFile(path.join(path.resolve(runDir), 'decision.json'), 'utf8'))
    const schemaErrors = validateDecisionDocument(decision)
    if (schemaErrors.length) {
      console.error('Decision INVALID; refusing to run a build gate:')
      for (const error of schemaErrors) console.error('- ' + error)
      process.exitCode = 1
      return
    }
    const command = arg('--command')
    const result = await runBuildGate({
      runDir,
      commands: command ? [command] : undefined,
      cwd: arg('--cwd', process.cwd()),
      timeoutMs: Number(arg('--timeout-ms', '300000')) || 300000,
    })
    if (wantsJson) {
      console.log(JSON.stringify({ schema: 'meetingbot/cli/gate/v1', ok: result.status === 'passed', ...result }, null, 2))
    } else {
      console.log(`Gate: ${result.status}`)
      for (const item of result.results || []) {
        console.log(`${item.ok ? 'PASS' : 'FAIL'} (${item.exitCode ?? 'timeout'}) ${item.command}`)
      }
    }
    if (result.status !== 'passed') process.exitCode = 1
    return
  }

  if (cmd === 'repair') {
    const dir = argv[1]
    if (!dir) throw new Error('repair requires a run directory')
    const result = await repairDecision({
      runDir: dir,
      configPath: arg('--config') || undefined,
      timeoutMs: Number(arg('--timeout-ms')) || 600000,
    })
    console.log(`Repaired decision: ${path.join(result.runDir, 'decision.md')}`)
    console.log(`Foreman: ${result.foreman.id} / ${result.durationMs}ms`)
    return
  }

  if (cmd === 'panel') {
    const configPath = arg('--config')
    if (!configPath) throw new Error('panel requires --config')
    const host = arg('--host', '127.0.0.1')
    const panel = await startPanel({ configPath, port: Number(arg('--port')) || 4318, host, token: arg('--token') || process.env.MEETINGBOT_PANEL_TOKEN || '', tlsCert: arg('--tls-cert'), tlsKey: arg('--tls-key'), tlsPfx: arg('--tls-pfx'), tlsPassphrase: arg('--tls-passphrase'), allowInsecure: has('--allow-insecure') })
    if (host !== '127.0.0.1' && host !== 'localhost') console.log('Remote access enabled: pre-shared token required; use --tls-cert/--tls-key (or --allow-insecure only on a trusted transport).')
    console.log(`MeetingBot panel: ${panel.url}`)
    console.log('Ctrl+C to stop. The panel runs real meetings from the UI; "示例演示" is labelled sample data.')
    return
  }

  if (cmd === 'ask') {
    const configPath = arg('--config')
    const agentId = arg('--agent')
    const prompt = arg('--prompt')
    if (!configPath || !agentId) throw new Error('ask requires --config and --agent')
    const text = prompt || (arg('--file') ? await fs.readFile(arg('--file'), 'utf8') : '')
    if (!text) throw new Error('ask requires --prompt or --file')
    const result = await askSingle({
      configPath,
      agentId,
      prompt: text,
      system: arg('--system', ''),
      maxTokens: Number(arg('--max-tokens')) || undefined,
      timeoutMs: Number(arg('--timeout-ms')) || undefined,
    })
    console.log(result.content)
    console.error(`[${result.label} ${result.model} · ${result.durationMs}ms]`)
    return
  }

  if (cmd === 'keys' && argv[1] === 'rotate') {
    const result = rotateMaster()
    console.log(`Vault master rotated; re-encrypted ${result.rotated} entries.`)
    return
  }

  if (cmd === 'verify') {
    const dir = argv[1]
    if (!dir) throw new Error('verify requires a run directory')
    const decision = JSON.parse(await fs.readFile(path.join(path.resolve(dir), 'decision.json'), 'utf8'))
    const errors = validateDecisionDocument(decision)
    const result = { schema: 'meetingbot/cli/verify/v1', ok: errors.length === 0, errors, decision: path.join(path.resolve(dir), 'decision.json') }
    if (wantsJson) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(result.ok ? 'Decision OK' : 'Decision INVALID')
      for (const error of errors) console.log('- ' + error)
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  if (cmd === 'export') {
    const dir = argv[1]
    if (!dir) throw new Error('export requires a run directory')
    const result = await exportRun(dir, { outPath: arg('--out') || undefined })
    if (wantsJson) console.log(JSON.stringify({ schema: 'meetingbot/cli/export/v1', ok: true, ...result }, null, 2))
    else console.log(`Signed bundle: ${result.path}\nFiles: ${result.files} · key: ${result.keyFile}`)
    return
  }

  if (cmd === 'verify-bundle') {
    const file = argv[1]
    if (!file) throw new Error('verify-bundle requires a bundle file')
    const result = await verifyBundle(file, { publicKey: arg('--public-key') || undefined })
    const { document, ...resultPublic } = result
    if (wantsJson) console.log(JSON.stringify({ schema: 'meetingbot/cli/verify-bundle/v1', ok: true, ...resultPublic }, null, 2))
    else console.log(`Bundle OK: ${result.bundle}\nRun: ${result.runId} · files: ${result.files}`)
    return
  }

  if (cmd === 'replay-bundle') {
    const file = argv[1]
    if (!file) throw new Error('replay-bundle requires a bundle file')
    const result = await replayBundle(file, { publicKey: arg('--public-key') || undefined })
    const { document, ...resultPublic } = result
    if (wantsJson) console.log(JSON.stringify({ schema: 'meetingbot/cli/replay-bundle/v1', ok: result.matches, ...resultPublic }, null, 2))
    else {
      console.log(`Replay winner: ${result.replayWinner}`)
      console.log(`Saved winner: ${result.expectedWinner}`)
      console.log(result.matches ? 'MATCH' : 'MISMATCH')
    }
    if (!result.matches) process.exitCode = 1
    return
  }

  if (cmd === 'pr-review') {
    const repo = arg('--repo', process.cwd())
    const result = await writePrReviewBrief({
      repo,
      base: arg('--base', 'main'),
      head: arg('--head', 'HEAD'),
      outPath: arg('--out', path.join(repo, 'pr-review-brief.md')),
      title: arg('--title', ''),
      maxDiffChars: Number(arg('--max-diff-chars')) || 60000,
    })
    if (wantsJson) console.log(JSON.stringify({ schema: 'meetingbot/cli/pr-review/v1', ok: true, ...result }, null, 2))
    else {
      console.log(`PR review brief: ${result.path}`)
      console.log(`Files: ${result.files.length} · ${result.bytes} bytes`)
      console.log(`Next: node bin/meetingbot.mjs start --brief ${result.path} --config <config>`)
    }
    return
  }

  if (cmd === 'show') {
    const dir = argv[1]
    if (!dir) throw new Error('show requires a run directory')
    console.log(await fs.readFile(path.join(dir, 'decision.md'), 'utf8'))
    return
  }

  if (cmd === 'list') {
    const base = path.resolve(argv[1] || 'runs')
    let dirs = []
    try { dirs = await fs.readdir(base) } catch { /* absent */ }
    for (const name of dirs.sort()) {
      const meta = path.join(base, name, 'meta.json')
      try {
        const j = JSON.parse(await fs.readFile(meta, 'utf8'))
        console.log(`${name}\t${j.mode}\t${j.winner}\t${j.foreman}\t${(j.selected || []).map((p) => p.id).join(',')}`)
      } catch { /* ignore */ }
    }
    return
  }

  throw new Error('unknown command: ' + cmd)
}

main().catch((error) => {
  const message = String(error?.message || error)
  if (wantsJson) console.error(JSON.stringify({ schema: 'meetingbot/cli/error/v1', ok: false, error: message }))
  else console.error('MeetingBot failed: ' + message)
  process.exitCode = 2
})
