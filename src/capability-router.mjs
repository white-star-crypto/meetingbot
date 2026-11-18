const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)))

// Capability profiles are intentionally local and editable. They rank models for
// a task, but never replace the roster: routing can only pick from selected IDs.
export const DEFAULT_PROFILES = {
  reasoning: {
    'ds-flash': 86,
    'minimax-flash': 80,
    'glm-flash': 78,
    'wenxin-51': 76,
    'qwen-flash': 74,
    'doubao-turbo': 70,
    'mimo-flash': 66,
  },
  code: {
    'ds-flash': 86,
    'glm-flash': 80,
    'minimax-flash': 78,
    'qwen-flash': 72,
    'wenxin-51': 68,
    'doubao-turbo': 66,
    'mimo-flash': 64,
  },
  visual: {
    'doubao-turbo': 86,
    'qwen-flash': 82,
    'mimo-flash': 78,
    'ds-flash': 70,
    'minimax-flash': 68,
    'glm-flash': 64,
    'wenxin-51': 60,
  },
  writing: {
    'glm-flash': 82,
    'qwen-flash': 80,
    'doubao-turbo': 78,
    'mimo-flash': 74,
    'ds-flash': 72,
    'wenxin-51': 70,
    'minimax-flash': 66,
  },
}

const DOMAIN_RE = {
  code: /代码|编程|bug|重构|接口|测试|架构|typescript|javascript|python|svg|算法|部署|性能/i,
  visual: /ui|界面|视觉|配色|排版|插画|海报|图片|动画|设计|首屏|布局/i,
  reasoning: /推理|分析|方案|决策|为什么|比较|权衡|数学|逻辑|评审|评估|风险/i,
  writing: /文档|文案|总结|翻译|润色|标题|说明|文档|报告/i,
}

const ROLE_LABELS = {
  reasoning: '推理 / 决策',
  code: '代码 / 架构',
  visual: '视觉 / 体验',
  writing: '文案 / 表达',
}

export function classifyDomain(text) {
  const source = String(text || '')
  const scores = Object.entries(DOMAIN_RE).map(([domain, re]) => {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    return [domain, [...source.matchAll(global)].length]
  })
  const max = Math.max(...scores.map(([, count]) => count))
  if (!max) return 'reasoning'
  const top = scores.filter(([, count]) => count === max).map(([domain]) => domain)
  // An exact multi-domain tie is not a reason to pick the alphabetically first
  // domain; route to the generic reasoning role until the owner gives detail.
  return top.length === 1 ? top[0] : 'reasoning'
}

export function routeTask(task, { mode = 'ondemand', profiles = DEFAULT_PROFILES, allowed = [] } = {}) {
  const domain = classifyDomain(task)
  const allowedSet = new Set((Array.isArray(allowed) ? allowed : []).filter(Boolean))
  const rankFor = (name) => {
    const profile = profiles[name] || profiles.reasoning || {}
    const entries = Object.entries(profile)
      .filter(([id]) => !allowedSet.size || allowedSet.has(id))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (!entries.length && allowedSet.size) {
      return [...allowedSet].map((id, index) => [id, 100 - index])
    }
    return entries
  }

  if (mode === 'division') {
    const assignments = {}
    const used = new Set()
    const domainOrder = [domain, ...['reasoning', 'code', 'visual', 'writing'].filter((name) => name !== domain)]
    for (const name of domainOrder) {
      const pick = rankFor(name).find(([id]) => !used.has(id))
      if (pick) {
        assignments[name] = pick[0]
        used.add(pick[0])
      }
    }
    const ranked = rankFor(domain)
    return {
      mode,
      domain,
      ranked,
      assignments,
      roles: Object.fromEntries(Object.entries(assignments).map(([name, id]) => [id, ROLE_LABELS[name]])),
      reviewer: ranked.find(([id]) => !used.has(id))?.[0] || ranked[0]?.[0] || null,
      fallback: ranked.slice(1, 4).map(([id]) => id),
      reason: '分工制：每个能力域选一个主责模型，第二轮由未主责的模型交叉审查',
    }
  }

  const ranked = rankFor(domain)
  const primary = ranked[0]?.[0] || null
  const reviewer = ranked[1]?.[0] || ranked[0]?.[0] || null
  return {
    mode: 'ondemand',
    domain,
    primary,
    reviewer,
    fallback: ranked.slice(1, 4).map(([id]) => id),
    ranked,
    reason: `按需分配：${ROLE_LABELS[domain] || domain}由第一顺位主责，第二顺位交叉审查`,
  }
}

export function planWorkMode({ task, mode = 'council', participants = [], profiles = DEFAULT_PROFILES }) {
  const ids = participants.map((participant) => participant.id)
  if (mode === 'council') {
    return {
      mode: 'council',
      domain: classifyDomain(task),
      participants,
      roles: {},
      routing: { reason: '合议协作：全部已选模型独立提案、交叉批判、共同投票' },
    }
  }
  const route = routeTask(task, { mode, profiles, allowed: ids })
  const byId = new Map(participants.map((participant) => [participant.id, participant]))
  let order = []
  if (mode === 'division') {
    order = [...new Set(Object.values(route.assignments || {}))]
    // If the selected roster is smaller than the number of domains, keep both
    // selected models (the meeting still needs a quorum of two).
    if (order.length < 2) order = [...new Set([...order, ...ids])].slice(0, Math.max(2, ids.length))
  } else {
    order = [...new Set([route.primary, route.reviewer].filter(Boolean))]
    if (order.length < 2) order = [...new Set([...order, ...ids])].slice(0, 2)
  }
  const routed = order.map((id) => byId.get(id)).filter(Boolean)
  return {
    mode,
    domain: route.domain,
    participants: routed,
    roles: route.roles || {},
    routing: {
      domain: route.domain,
      assignments: route.assignments || { [route.domain]: route.primary },
      primary: route.primary || null,
      reviewer: route.reviewer || null,
      fallback: route.fallback || [],
      reason: route.reason,
    },
  }
}

export function recordCalibration(profiles, { domain, model, score, sample = 1 }) {
  const p = profiles[domain] || (profiles[domain] = {})
  const old = Number(p[model] ?? 50)
  const weight = 1 / Math.max(1, sample)
  p[model] = clamp(old * (1 - weight) + Number(score) * weight)
  return p
}

export function confidence(ranked, spread = 14) {
  if (!ranked?.length) return 0
  const gap = ranked[0][1] - (ranked[1]?.[1] ?? ranked[0][1])
  return Math.min(100, Math.round((gap / spread) * 100))
}
