import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRoot } from './data-root.mjs'

const text = (value, max = 4000) => String(value ?? '').trim().slice(0, max)

export function createAccountService({ dataRoot = resolveDataRoot() } = {}) {
  const stateDir = path.join(dataRoot, 'state')
  const file = path.join(stateDir, 'account.json')
  const keyFile = path.join(stateDir, 'account.key')
  let state = null
  let key = null
  const load = async () => {
    if (state) return state
    try { state = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') state = { cloud: null, session: null }; else throw new Error('account state is unreadable or corrupt') }
    return state
  }
  const loadKey = async () => {
    if (key) return key
    await fs.mkdir(stateDir, { recursive: true })
    try { key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'hex') } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      key = crypto.randomBytes(32)
      await fs.writeFile(keyFile, key.toString('hex') + '\n', { mode: 0o600 })
    }
    if (key.length !== 32) throw new Error('account key is invalid')
    return key
  }
  const encrypt = async (value) => {
    const k = await loadKey(); const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
  }
  const decrypt = async (value) => {
    if (!value?.body) return null
    const k = await loadKey(); const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(value.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]).toString('utf8'))
  }
  const save = async () => {
    await fs.mkdir(stateDir, { recursive: true })
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }
  const baseUrl = () => {
    const url = text(state?.cloud?.url, 500).replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) throw new Error('Supabase URL must start with http(s)://')
    return url
  }
  const request = async (route, options = {}) => {
    const response = await fetch(baseUrl() + route, {
      ...options,
      headers: { apikey: state.cloud.anonKey, 'content-type': 'application/json', ...(state.session?.accessToken ? { authorization: `Bearer ${state.session.accessToken}` } : {}), ...(options.headers || {}) },
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.msg || data.error_description || data.error || `Supabase HTTP ${response.status}`)
    return data
  }
  let oauthServer = null
  let oauthState = null
  let oauthTimer = null
  const oauthCallbackHtml = `<!doctype html><meta charset="utf-8"><title>MeetingBot 登录</title><body style="font-family:system-ui;padding:40px;background:#f5f4ef;color:#1e2329"><h2>正在完成登录…</h2><p id="msg">请稍候</p><script>
  (async()=>{const h=new URLSearchParams(location.hash.slice(1));const q=new URLSearchParams(location.search);const data={state:h.get('state')||q.get('state'),access_token:h.get('access_token'),refresh_token:h.get('refresh_token'),expires_in:h.get('expires_in'),error:h.get('error_description')||q.get('error_description')};try{const r=await fetch('/auth/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const t=await r.text();document.getElementById('msg').textContent=t}catch(e){document.getElementById('msg').textContent='登录回调失败：'+e.message}})();
  </script></body>`
  const startOauthServer = () => new Promise((resolve, reject) => {
    if (oauthServer) return resolve()
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname === '/auth/callback') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(oauthCallbackHtml); return }
      if (u.pathname === '/auth/complete' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk
        try {
          const data = JSON.parse(raw || '{}')
          if (data.error) throw new Error(data.error)
          if (oauthState && data.state && data.state !== oauthState) throw new Error('OAuth state mismatch')
          if (!data.access_token) throw new Error('missing access token')
          const me = await fetch(baseUrl() + '/auth/v1/user', { headers: { apikey: state.cloud.anonKey, authorization: `Bearer ${data.access_token}` }, signal: AbortSignal.timeout(15000) })
          const user = await me.json().catch(() => ({}))
          if (!me.ok) throw new Error(user.msg || user.error_description || 'failed to load user')
          await persistSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: Number(data.expires_in) || 3600, user }, null)
          oauthState = null
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('登录成功，请回到 MeetingBot。')
          server.close(); oauthServer = null; if (oauthTimer) clearTimeout(oauthTimer)
        } catch (error) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('登录失败：' + error.message) }
        return
      }
      res.writeHead(404); res.end('not found')
    })
    server.once('error', reject)
    server.listen(53682, '127.0.0.1', () => { oauthServer = server; resolve() })
  })
  const getSession = async () => state?.session ? decrypt(state.session).catch(() => null) : null
  const persistSession = async (data, fallbackUser = null) => {
    const user = data?.user || fallbackUser
    if (!user || !data?.access_token) return null
    state.session = await encrypt({ accessToken: data.access_token, refreshToken: data.refresh_token || fallbackUser?.refreshToken, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, user: { id: user.id, email: user.email } })
    state.profile = { id: user.id, email: user.email, displayName: user.user_metadata?.display_name || user.email?.split('@')[0] || '账号' }
    await save()
    return { profile: state.profile }
  }
  const refreshSession = async () => {
    const session = await getSession()
    if (!session?.refreshToken) throw new Error('sign in required')
    const response = await fetch(baseUrl() + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: state.cloud.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.msg || data.error_description || data.error || `Supabase HTTP ${response.status}`)
    return persistSession(data, { ...session.user, refreshToken: session.refreshToken })
  }
  const authedFetch = async (url, options = {}) => {
    let session = await getSession()
    if (!session?.accessToken) throw new Error('sign in required')
    if (session.expiresAt && session.expiresAt - Date.now() < 60000) { await refreshSession(); session = await getSession() }
    const send = (token) => fetch(url, { ...options, headers: { apikey: state.cloud.anonKey, authorization: `Bearer ${token}`, ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) })
    let response = await send(session.accessToken)
    if (response.status === 401) { await refreshSession(); session = await getSession(); response = await send(session.accessToken) }
    return response
  }
  return {
    async get() {
      await load()
      const session = state.session ? await decrypt(state.session).catch(() => null) : null
      return { configured: Boolean(state.cloud?.url && state.cloud?.anonKey), cloud: state.cloud ? { url: state.cloud.url } : null, profile: state.profile || null, signedIn: Boolean(session?.refreshToken), email: state.profile?.email || '' }
    },
    async configure({ url, anonKey }) {
      const cleanUrl = text(url, 500).replace(/\/+$/, '')
      const cleanKey = text(anonKey, 2000)
      if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('Supabase URL must start with http(s)://')
      if (!cleanKey) throw new Error('anon key required')
      await load(); const changed = state.cloud?.url !== cleanUrl || state.cloud?.anonKey !== cleanKey; state.cloud = { url: cleanUrl, anonKey: cleanKey }; if (changed) { state.session = null; state.profile = null } await save(); return this.get()
    },
    async signUp({ email, password }) {
      await load(); if (!state.cloud) throw new Error('Supabase is not configured')
      const data = await request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email: text(email, 320), password: String(password || '') }) })
      if (data.session) return persistSession(data)
      return { needsEmailConfirmation: true, email: text(email, 320) }
    },
    async signIn({ email, password }) {
      await load(); if (!state.cloud) throw new Error('Supabase is not configured')
      const data = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: text(email, 320), password: String(password || '') }) })
      return persistSession(data)
    },
    async oauthStart(provider) {
      await load(); if (!state.cloud) throw new Error('Supabase is not configured')
      if (!['github', 'google'].includes(provider)) throw new Error('unsupported provider')
      await startOauthServer()
      oauthState = crypto.randomBytes(16).toString('hex')
      if (oauthTimer) clearTimeout(oauthTimer)
      oauthTimer = setTimeout(() => { oauthState = null; if (oauthServer) { oauthServer.close(); oauthServer = null } }, 10 * 60 * 1000)
      const redirect = 'http://127.0.0.1:53682/auth/callback'
      return { url: baseUrl() + '/auth/v1/authorize?provider=' + encodeURIComponent(provider) + '&redirect_to=' + encodeURIComponent(redirect) + '&flow_type=implicit&state=' + oauthState }
    },
    async pushSettings(payload, { replace = false } = {}) {
      await load(); const session = await getSession()
      if (!session?.user?.id) throw new Error('sign in required')
      const remote = replace ? null : await this.pullSettings().catch(() => null)
      const remotePayload = remote?.payload || {}
      const merged = { ...remotePayload, ...payload, preferences: { ...(remotePayload.preferences || {}), ...(payload?.preferences || {}) } }
      if (Array.isArray(remotePayload.workspaceCommon) && Array.isArray(payload?.workspaceCommon)) merged.workspaceCommon = [...new Set([...remotePayload.workspaceCommon, ...payload.workspaceCommon])]
      const response = await authedFetch(baseUrl() + '/rest/v1/user_settings?on_conflict=user_id', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{ user_id: session.user.id, schema_version: 1, payload: merged, revision: Date.now(), updated_at: new Date().toISOString() }]),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || data.error || `Supabase HTTP ${response.status}`)
      return Array.isArray(data) ? data[0] : data
    },
    async pullSettings() {
      await load(); const session = await getSession()
      if (!session?.user?.id) throw new Error('sign in required')
      const response = await authedFetch(baseUrl() + `/rest/v1/user_settings?select=payload,revision,updated_at&user_id=eq.${encodeURIComponent(session.user.id)}`, { headers: {} })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || data.error || `Supabase HTTP ${response.status}`)
      return Array.isArray(data) ? data[0] || null : null
    },
    async resetLocal() {
      await load(); state.session = null; state.profile = null; await save(); return { ok: true }
    },
    async signOut() {
      await load()
      if (state.session) { try { await request('/auth/v1/logout', { method: 'POST' }) } catch {} }
      state.session = null; state.profile = null; await save(); return { ok: true }
    },
  }
}
