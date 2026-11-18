const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)))
const has = (re, s) => re.test(String(s || ''))

export function estimateTask(text, { sourceChars = 0, modelCount = 7 } = {}) {
  const chars = String(text || '').length
  const kind = has(/svg|动画|插画|海报|配色|审美|视觉|ui|界面|排版/i, text)
    ? 'visual'
    : has(/代码|重构|审计|源码|架构|bug|测试|性能|安全/i, text)
      ? 'code'
      : has(/评审|建议|方案|决策|分析|对比/i, text)
        ? 'review'
        : 'chat'
  const complexity = clamp((chars / 1200) + (sourceChars / 8000) + (modelCount * 0.6), 1, 10)
  // Defaults are deliberately small; escalation is explicit and bounded.
  const plan = clamp(4000 + complexity * 900 + (kind === 'visual' ? 2500 : 0), 4000, 20000)
  const main = clamp(plan * 1.6 + complexity * 1200 + (kind === 'visual' ? 4000 : 0), 8000, 50000)
  const reason = complexity >= 7 || kind === 'code' ? 'high' : 'medium'
  return {
    kind, complexity: Number(complexity.toFixed(2)), modelCount,
    planTokens: plan, mainTokens: main, reasoning: reason,
    planTimeoutMs: clamp(120000 + complexity * 45000, 180000, 900000),
    mainTimeoutMs: clamp(240000 + complexity * 90000, 300000, 1500000),
    escalation: { onFinishReason: ['length', 'max_tokens'], factor: 1.6, maxTokens: 50000 },
  }
}

