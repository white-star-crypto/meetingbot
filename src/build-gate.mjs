import { childEnv } from './child-env.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_CAPTURE = 6000

function truncate(value, limit = MAX_CAPTURE) {
  const text = String(value || '')
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ command, durationMs: Date.now() - started, ...result })
    }
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: childEnv({ CI: '1' }),
      })
    } catch (error) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: String(error?.message || error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: childEnv() })
        else child.kill('SIGKILL')
      } catch { try { child.kill() } catch {} }
      finish({ ok: false, exitCode: null, timedOut: true, stdout: truncate(stdout), stderr: truncate(stderr) + '\n[gate timeout]' })
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_CAPTURE * 2) stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { if (stderr.length < MAX_CAPTURE * 2) stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr) + '\n' + String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) })
    })
  })
}

/**
 * External hard gate for a decision artifact.
 *
 * Contract: reads decision.json, writes gate.json, updates decision.json's
 * buildGate/blocked/canBuild fields, and returns the result object. runMeeting
 * also merges the returned object explicitly, so a future pure-function refactor
 * cannot silently leave canBuild false.
 */
export async function runBuildGate({ runDir, commands = [], cwd = process.cwd(), timeoutMs = 300000 } = {}) {
  const dir = path.resolve(runDir)
  const decisionPath = path.join(dir, 'decision.json')
  const decision = JSON.parse(await fs.readFile(decisionPath, 'utf8'))
  const quorumValid = decision.quorum?.valid === true
  const gate = decision.buildGate && typeof decision.buildGate === 'object'
    ? { ...decision.buildGate }
    : { required: true, status: 'unverified', commands: [] }
  const requested = Array.isArray(commands) && commands.length ? commands : (gate.commands || [])
  const list = requested.map(String).map((s) => s.trim()).filter(Boolean)

  if (!quorumValid) {
    const result = {
      schema: 'meetingbot/gate/v1',
      checkedAt: new Date().toISOString(),
      status: 'blocked',
      reason: 'decision.quorum.valid is false',
      quorumValid: false,
      commands: [],
      results: [],
    }
    await fs.writeFile(path.join(dir, 'gate.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
    decision.buildGate = { ...gate, ...result, status: 'blocked' }
    decision.blocked = true
    decision.ownerGate = true
    decision.canBuild = false
    result.blocked = true
    result.ownerGate = true
    await fs.writeFile(decisionPath, JSON.stringify(decision, null, 2) + '\n', 'utf8')
    return result
  }

  if (!list.length) {
    const result = {
      schema: 'meetingbot/gate/v1',
      checkedAt: new Date().toISOString(),
      status: gate.required === false ? 'unverified' : 'blocked',
      reason: 'no gate commands configured',
      quorumValid: true,
      commands: [],
      results: [],
    }
    await fs.writeFile(path.join(dir, 'gate.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
    decision.buildGate = { ...gate, ...result }
    if (result.status === 'blocked') {
      decision.blocked = true
      decision.ownerGate = true
    }
    if (decision.fallback === true || decision.repairRequiresGate === true) {
      decision.ownerGate = true
      decision.blocked = decision.blocked === true
    }
    decision.canBuild = gate.required === false && !decision.blocked && !decision.ownerGate
    result.blocked = !!decision.blocked
    result.ownerGate = !!decision.ownerGate
    await fs.writeFile(decisionPath, JSON.stringify(decision, null, 2) + '\n', 'utf8')
    return result
  }

  const results = []
  for (const command of list) {
    results.push(await runCommand(command, cwd, timeoutMs))
  }
  const passed = results.every((item) => item.ok)
  const result = {
    schema: 'meetingbot/gate/v1',
    checkedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    reason: passed ? 'all gate commands passed' : 'one or more gate commands failed',
    quorumValid: true,
    cwd: path.resolve(cwd),
    commands: list,
    results,
  }
  await fs.writeFile(path.join(dir, 'gate.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  decision.buildGate = { ...gate, ...result }
  if (!passed) {
    decision.blocked = true
    decision.ownerGate = true
  } else {
    // A passing gate may satisfy the gate itself, but it must never erase a
    // quorum/fallback/repair/owner block that was already recorded.
    decision.blocked = decision.blocked === true
    decision.ownerGate = decision.ownerGate === true
    if (decision.fallback === true || decision.repairRequiresGate === true) {
      decision.ownerGate = true
    }
  }
  decision.canBuild = passed && !decision.blocked && !decision.ownerGate
  result.blocked = decision.blocked
  result.ownerGate = decision.ownerGate
  await fs.writeFile(decisionPath, JSON.stringify(decision, null, 2) + '\n', 'utf8')
  return result
}
