#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (!message || message.id === undefined) return
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
    })
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'echo',
        description: 'Echo the provided JSON arguments.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      }],
    })
  } else if (message.method === 'tools/call') {
    reply(message.id, {
      content: [{ type: 'text', text: JSON.stringify(message.params?.arguments || {}) }],
      isError: false,
    })
  } else {
    reply(message.id, {})
  }
})
