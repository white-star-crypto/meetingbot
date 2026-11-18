const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function endpoint(baseUrl, provider) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (provider === 'minimax') {
    if (/\/text\/chatcompletion_v2$/.test(base)) return base
    return base + '/text/chatcompletion_v2'
  }
  if (/\/chat\/completions$/.test(base)) return base
  return base + '/chat/completions'
}

export async function callChat(participant, messages, settings) {
  const url = endpoint(participant.baseUrl, participant.provider)
  const body = {
    model: participant.model,
    messages,
    temperature: participant.temperature ?? settings.temperature,
    max_tokens: settings.maxTokens,
  }
  if (participant.noThink) body.enable_thinking = false
  if (participant.reasoningEffort) body.reasoning_effort = participant.reasoningEffort
  if (participant.jsonMode) body.response_format = { type: 'json_object' }
  const started = Date.now()
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController()
    const timeoutMs = Math.max(1000, Number(settings.timeoutMs) || 120000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let text
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${participant.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${participant.id}: network error: request timed out after ${timeoutMs}ms`)
      }
      lastError = error
      if (attempt < 3) { await sleep(2000 * (2 ** attempt)); continue }
      throw new Error(`${participant.id}: network error: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      lastError = new Error(`${participant.id}: HTTP ${response.status}: ${text.slice(0, 300)}`)
      if (RETRY_STATUS.has(response.status) && attempt < 3) {
        const raw = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(raw) && raw > 0 ? Math.min(30000, raw * 1000) : 2000 * (2 ** attempt)
        await sleep(delay)
        continue
      }
      throw lastError
    }
    let data
    try { data = JSON.parse(text) } catch { throw new Error(`${participant.id}: response is not JSON`) }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`${participant.id}: empty content`)
    }
    return {
      content,
      usage: data.usage || null,
      durationMs: Date.now() - started,
      finishReason: data?.choices?.[0]?.finish_reason || null,
    }
  }
  throw lastError || new Error(`${participant.id}: request failed`)
}

export function extractJson(text) {
  const source = String(text || '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : source
  try {
    const parsed = JSON.parse(candidate)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model JSON must be an object')
    return parsed
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch { /* fall through */ }
    }
    throw new Error('model did not return a JSON object: ' + candidate.slice(0, 240))
  }
}
