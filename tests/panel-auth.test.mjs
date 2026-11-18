#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { startPanel } from '../src/panel-server.mjs'

const configPath = path.resolve(import.meta.dirname, '..', 'examples', 'config.mock.json')
const panel = await startPanel({ configPath, port: 0 })
const base = panel.url
const raw = (options) => new Promise((resolve, reject) => {
  const req = http.request(options, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
  })
  req.on('error', reject)
  req.end()
})
try {
  const unauthorized = await fetch(base + '/api/config')
  assert.equal(unauthorized.status, 401)

  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  const setCookie = page.headers.getSetCookie?.()[0] || page.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  assert.match(cookie, /^meetingbot_session=[a-f0-9]{64}$/)

  const authorized = await fetch(base + '/api/config', { headers: { cookie } })
  assert.equal(authorized.status, 200)
  const authorizedBody = await authorized.json()
  assert.equal(Array.isArray(authorizedBody.roster), true)

  const evilOrigin = await fetch(base + '/api/config', { headers: { cookie, origin: 'https://evil.example' } })
  assert.equal(evilOrigin.status, 403)

  const evilHost = await raw({
    hostname: '127.0.0.1',
    port: panel.port,
    path: '/api/config',
    headers: { host: `evil.example:${panel.port}`, cookie },
  })
  assert.equal(evilHost.status, 403)

  const simpleCrossSite = await raw({
    method: 'POST',
    hostname: '127.0.0.1',
    port: panel.port,
    path: '/api/feedback',
    headers: { 'content-type': 'text/plain', host: `127.0.0.1:${panel.port}` },
  })
  assert.equal(simpleCrossSite.status, 401)
  const ssrf = await fetch(base + '/api/provider-test', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://192.168.1.1:9/v1', apiKey: 'x', model: 'm' }),
  })
  assert.equal(ssrf.status, 400)

  const keyEgress = await fetch(base + '/api/provider-test', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://evil.example/v1', keyName: 'not-configured', model: 'm' }),
  })
  assert.equal(keyEgress.status, 400)
  await new Promise((resolve) => panel.server.close(resolve))
  assert.throws(() => startPanel({ configPath, port: 0, host: '0.0.0.0', token: 'remote-secret' }), /TLS|allow-insecure/)
  const secure = await startPanel({ configPath, port: 0, host: '0.0.0.0', token: 'remote-secret', allowInsecure: true })
  try {
    const loginPage = await fetch(secure.url + '/')
    assert.equal(loginPage.status, 200)
    assert.match(await loginPage.text(), /panel-login/)
    const unauthApi = await fetch(secure.url + '/api/config')
    assert.equal(unauthApi.status, 401)
    const login = await fetch(secure.url + '/panel-login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=remote-secret', redirect: 'manual' })
    assert.equal(login.status, 303)
    assert.match(login.headers.get('location') || '', /^\/$/)
    assert.match(login.headers.get('set-cookie') || '', /Max-Age=43200/)
    const remoteApi = await fetch(secure.url + '/api/config', { headers: { 'x-meetingbot-token': 'remote-secret' } })
    assert.equal(remoteApi.status, 200)
    let lastStatus = 0
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const bad = await fetch(secure.url + '/panel-login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual' })
      lastStatus = bad.status
    }
    assert.equal(lastStatus, 429)
  } finally {
    await new Promise((resolve) => secure.server.close(resolve))
  }
  console.log('PASS panel auth: cookie gate, Host/Origin rejection, no bare API writes')
} finally {
  await new Promise((resolve) => panel.server.close(resolve))
}
