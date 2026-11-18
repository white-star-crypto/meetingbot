import { spawn } from 'node:child_process'
import path from 'node:path'
import { childEnv } from './child-env.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT = 20000
const MAX_LINE = 4 * 1024 * 1024
const activeConnections = new Set()

export async function closeAllMcp() {
  const connections = [...activeConnections]
  await Promise.allSettled(connections.map((connection) => connection.close()))
  activeConnections.clear()
}


function asText(value, limit = 12000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > limit ? text.slice(0, limit) + '\n…（截断）' : text
}

class McpConnection {
  constructor(server, { timeoutMs = DEFAULT_TIMEOUT, permission = 'read-only' } = {}) {
    this.server = server
    this.timeoutMs = timeoutMs
    this.permission = permission
    this.child = null
    this.buffer = ''
    this.stderr = ''
    this.nextId = 1
    this.pending = new Map()
    this.tools = []
    this.closed = false
    activeConnections.add(this)
  }

  async start() {
    if (this.child) return
    if (!this.server?.command) throw new Error(`mcp server ${this.server?.id || '?'} has no command`)
    this.child = spawn(this.server.command, this.server.args || [], {
      cwd: this.server.cwd ? path.resolve(this.server.cwd) : undefined,
      env: childEnv(this.server.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdin.on('error', (error) => this.failAll(error))
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.child.on('error', (error) => this.failAll(error))
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.failAll(new Error(`mcp server exited (${code ?? signal}) ${this.stderr.slice(-500)}`))
    })
    try {
      const initialized = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'meetingbot', version: '2.1' },
      })
      if (!initialized || typeof initialized !== 'object') throw new Error('invalid initialize response')
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    } catch (error) {
      await this.close()
      throw error
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable || this.closed) throw new Error('mcp connection is not writable')
    this.child.stdin.write(JSON.stringify(message) + '\n', 'utf8', (error) => {
      if (error) this.failAll(error)
    })
  }

  onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE) {
      this.buffer = ''
      this.failAll(new Error('mcp response line too large'))
      return
    }
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(String(message.error.message || 'mcp error')))
        else entry.resolve(message.result)
      }
      // Server-initiated requests are not supported. Notifications are ignored.
    }
  }

  failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('mcp connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp ${method} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  async listTools() {
    await this.start()
    if (this.server.readOnly === true && this.permission === 'read-only') {
      // readOnly servers are explicitly allowed in read-only mode.
    } else if (this.permission === 'read-only') {
      throw new Error('mcp server is not marked readOnly; switch permission mode first')
    }
    const result = await this.request('tools/list', {})
    this.tools = Array.isArray(result?.tools) ? result.tools : []
    return this.tools.map((tool) => ({
      server: this.server.id,
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema || null,
      readOnly: this.server.readOnly === true,
    })).filter((tool) => tool.name)
  }

  async callTool(name, args = {}) {
    await this.start()
    if (this.permission === 'read-only' && this.server.readOnly !== true) {
      throw new Error('mcp tool is blocked in read-only mode; change the permission mode explicitly')
    }
    const result = await this.request('tools/call', { name: String(name), arguments: args && typeof args === 'object' ? args : {} })
    return {
      ok: result?.isError !== true,
      server: this.server.id,
      tool: name,
      content: asText(result?.content ?? result),
      raw: result,
    }
  }

  async close() {
    this.closed = true
    activeConnections.delete(this)
    this.failAll(new Error('mcp connection closed'))
    if (this.child) {
      const child = this.child
      const pid = child.pid
      this.child = null
      try { child.stdin.end() } catch { /* already closed */ }
      try {
        if (process.platform === 'win32' && pid) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: childEnv() })
        } else {
          try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
          setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch {} }, 2000).unref?.()
        }
      } catch { try { child.kill() } catch { /* already gone */ } }
    }
  }
}

export function createMcpManager({ config, permission = 'read-only', timeoutMs } = {}) {
  const settings = config?.mcp
  const servers = Array.isArray(settings?.servers) ? settings.servers : []
  const enabled = settings?.enabled === true
  const connections = new Map()
  const waitMs = Math.max(1000, Number(timeoutMs || settings?.timeoutMs) || DEFAULT_TIMEOUT)

  const activeServers = () => servers.filter((server) =>
    server && server.enabled !== false && server.command
    && (permission !== 'read-only' || server.readOnly === true))

  async function connection(server) {
    if (connections.has(server.id)) return connections.get(server.id)
    const conn = new McpConnection(server, { timeoutMs: waitMs, permission })
    connections.set(server.id, conn)
    return conn
  }

  async function listTools() {
    if (!enabled) return []
    const out = []
    for (const server of activeServers()) {
      try {
        const conn = await connection(server)
        out.push(...await conn.listTools())
      } catch (error) {
        out.push({ server: server.id, name: '', error: String(error?.message || error) })
      }
    }
    return out
  }

  async function call({ server, tool, arguments: args } = {}) {
    if (!enabled) throw new Error('mcp is disabled; set mcp.enabled=true and configure servers explicitly')
    const target = activeServers().find((item) => item.id === server)
    if (!target) throw new Error(`mcp server not enabled or not allowed in current permission: ${server}`)
    let conn = await connection(target)
    try {
      return await conn.callTool(tool, args)
    } catch (error) {
      if (!/EPIPE|closed|exited|writable|not writable/i.test(String(error?.message || error))) throw error
      // Never replay the call: the tool may have executed before the pipe died.
      // Drop the connection so the next explicit call reconnects cleanly.
      await conn.close().catch(() => {})
      connections.delete(target.id)
      throw error
    }
  }

  async function status() {
    return {
      enabled,
      permission,
      servers: servers.map((server) => ({
        id: server.id,
        label: server.label || server.id,
        enabled: server.enabled !== false,
        readOnly: server.readOnly === true,
        command: server.command || '',
        active: activeServers().includes(server),
        connected: connections.has(server.id),
        tools: connections.get(server.id)?.tools?.length || 0,
      })),
    }
  }

  async function close() {
    await Promise.all([...connections.values()].map((conn) => conn.close()))
    connections.clear()
  }

  return { enabled, listTools, call, status, close }
}

export { McpConnection }
