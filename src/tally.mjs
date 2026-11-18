const DIMENSIONS = ['architecture', 'aesthetics', 'security']

function clamp(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null
}

function normalizeScore(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      architecture: clamp(value.architecture),
      aesthetics: clamp(value.aesthetics),
      security: clamp(value.security),
    }
  }
  const n = clamp(value)
  return { architecture: n, aesthetics: n, security: n }
}

function dimensionWeight(tags, dimension, boost = 1.25) {
  const list = Array.isArray(tags) ? tags : []
  if (dimension === 'architecture' && list.some((t) => ['code', 'reasoning', 'architecture'].includes(t))) return boost
  if (dimension === 'aesthetics' && list.some((t) => ['design', 'multimodal', 'aesthetic'].includes(t))) return boost
  if (dimension === 'security' && list.some((t) => ['security', 'safety', 'audit'].includes(t))) return boost
  return 1
}

function uniqueIds(values, ids) {
  const seen = new Set()
  return (Array.isArray(values) ? values : [])
    .map(String)
    .filter((id) => ids.has(id) && !seen.has(id) && seen.add(id))
}

function weightedAverage(dims, weights) {
  let sum = 0
  let weight = 0
  for (const dim of DIMENSIONS) {
    const w = Number(weights[dim]) || 0
    if (!w || !dims[dim]?.weight) continue
    sum += (dims[dim].sum / dims[dim].weight) * w
    weight += w
  }
  return weight ? sum / weight : 0
}

function scoreForAudit(score) {
  return Object.fromEntries(DIMENSIONS.map((dim) => [dim, score[dim]]))
}

/**
 * Pure tally function. No network, no filesystem, no globals.
 *
 * Self-review policy:
 * - self votes never count as a first-place vote (they transfer to the next choice)
 * - self scores can be excluded (default) or downweighted from the overall score
 * - self rankings are removed from pairwise comparisons by default
 * - tally-audit keeps the per-ballot scores and the self-vs-others comparison
 */
export function tally(proposals, ballots, options = {}) {
  const ids = new Set(proposals.map((p) => p.id))
  const dimensionWeights = (() => {
    const weight = (key, fallback) => {
      const raw = options.dimensionWeights?.[key]
      const value = Number(raw)
      return Number.isFinite(value) && raw !== '' && raw != null ? Math.max(0, Math.min(1, value)) : fallback
    }
    return { architecture: weight('architecture', 0.45), aesthetics: weight('aesthetics', 0.35), security: weight('security', 0.20) }
  })()
  const selfScorePolicy = ['exclude', 'downweight', 'include'].includes(String(options.selfScorePolicy))
    ? String(options.selfScorePolicy)
    : 'exclude'
  const selfScoreWeight = Math.max(0, Math.min(1, Number(options.selfScoreWeight) || 0))
  const stripSelfFromRanking = options.stripSelfFromRanking !== false
  const voterTagBoost = Math.max(1, Math.min(2, Number(options.voterTagBoost) || 1.25))
  const requestedMethod = ['auto', 'condorcet', 'weighted'].includes(String(options.method))
    ? String(options.method)
    : 'auto'
  const totals = new Map(proposals.map((p) => [p.id, {
    dims: Object.fromEntries(DIMENSIONS.map((d) => [d, { sum: 0, weight: 0 }])),
    otherDims: Object.fromEntries(DIMENSIONS.map((d) => [d, { sum: 0, weight: 0 }])),
    selfDims: Object.fromEntries(DIMENSIONS.map((d) => [d, { sum: 0, weight: 0 }])),
    first: 0,
    selfVotes: 0,
    otherVotes: 0,
    condorcetWins: 0,
  }]))
  const pairwise = Object.fromEntries(proposals.map((a) => [a.id, Object.fromEntries(proposals.map((b) => [b.id, 0]))]))
  const selfTransfers = []
  const selfAbstentions = []
  const selfEvaluations = []
  const normalizedBallots = []

  for (const ballot of ballots) {
    const ranking = uniqueIds(ballot.ranking, ids)
    const self = String(ballot.selfProposalId || '')
    let voteFor = String(ballot.vote_for || ranking[0] || '')
    if (self && voteFor === self) {
      const next = ranking.find((id) => id !== self)
      if (next) {
        selfTransfers.push({ voter: ballot.voter, from: self, to: next })
        voteFor = next
      } else {
        selfAbstentions.push({ voter: ballot.voter, proposal: self })
        voteFor = ''
      }
    }
    if (voteFor && totals.has(voteFor)) totals.get(voteFor).first += 1

    const normalizedScores = Object.fromEntries(proposals.map((p) => [p.id, normalizeScore(ballot.scores?.[p.id])]))
    for (const p of proposals) {
      const score = normalizedScores[p.id]
      const hasAny = DIMENSIONS.some((dim) => score[dim] !== null)
      if (!hasAny) continue
      const slot = totals.get(p.id)
      const isSelf = !!self && self === p.id
      if (isSelf) {
        slot.selfVotes += 1
        for (const dim of DIMENSIONS) {
          if (score[dim] === null) continue
          const weight = dimensionWeight(ballot.voterTags, dim, voterTagBoost)
          slot.selfDims[dim].sum += score[dim] * weight
          slot.selfDims[dim].weight += weight
          if (selfScorePolicy !== 'exclude') {
            const applied = selfScorePolicy === 'downweight' ? weight * selfScoreWeight : weight
            slot.dims[dim].sum += score[dim] * applied
            slot.dims[dim].weight += applied
          }
        }
        const selfOverall = weightedAverage(
          Object.fromEntries(DIMENSIONS.map((dim) => [dim, {
            sum: (score[dim] ?? 0) * (score[dim] === null ? 0 : 1),
            weight: score[dim] === null ? 0 : 1,
          }])),
          dimensionWeights,
        )
        selfEvaluations.push({
          voter: ballot.voter,
          proposal: p.id,
          scores: scoreForAudit(score),
          overall: Number(selfOverall.toFixed(2)),
          policy: selfScorePolicy,
          selfWeight: selfScorePolicy === 'exclude' ? 0 : (selfScorePolicy === 'downweight' ? selfScoreWeight : 1),
        })
      } else {
        slot.otherVotes += 1
        for (const dim of DIMENSIONS) {
          if (score[dim] === null) continue
          const weight = dimensionWeight(ballot.voterTags, dim, voterTagBoost)
          slot.otherDims[dim].sum += score[dim] * weight
          slot.otherDims[dim].weight += weight
          slot.dims[dim].sum += score[dim] * weight
          slot.dims[dim].weight += weight
        }
      }
    }

    // Pairwise preference must not include the voter's own proposal: a self
    // ranking would otherwise reintroduce the self-bias that the first-place
    // transfer just removed.
    let pairRanking = stripSelfFromRanking && self ? ranking.filter((id) => id !== self) : ranking
    if (!pairRanking.length) {
      // A ballot with no ranking and no scores is a scrap ballot. Do not turn
      // it into an alphabetical preference: that can flip a close Condorcet
      // result. Only derive a ranking when at least two proposals have a real
      // score and the scores are not all tied.
      const scored = proposals
        .filter((p) => !(stripSelfFromRanking && self && p.id === self))
        .map((p) => {
          const score = normalizedScores[p.id]
          const vals = DIMENSIONS.map((d) => score[d]).filter((v) => v !== null)
          return { id: p.id, score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null }
        })
        .filter((item) => item.score !== null)
      if (scored.length >= 2 && new Set(scored.map((item) => item.score)).size > 1) {
        pairRanking = scored
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .map((x) => x.id)
      }
    }
    for (let i = 0; i < pairRanking.length; i++) {
      for (let j = i + 1; j < pairRanking.length; j++) {
        const a = pairRanking[i]
        const b = pairRanking[j]
        if (pairwise[a]?.[b] === undefined) continue
        pairwise[a][b] += 1
      }
    }

    normalizedBallots.push({
      voter: ballot.voter,
      voteFor,
      ranking,
      pairRanking,
      selfProposalId: self || null,
      scores: Object.fromEntries(proposals.map((p) => [p.id, scoreForAudit(normalizedScores[p.id])])),
    })
  }

  for (const a of proposals) {
    for (const b of proposals) {
      if (a.id !== b.id && pairwise[a.id][b.id] > pairwise[b.id][a.id]) {
        totals.get(a.id).condorcetWins += 1
      }
    }
  }

  const selfByProposal = new Map()
  for (const evaluation of selfEvaluations) {
    if (!selfByProposal.has(evaluation.proposal)) selfByProposal.set(evaluation.proposal, evaluation)
  }

  const validBallots = normalizedBallots.filter((ballot) =>
    ballot.ranking.length > 0
    || (ballot.voteFor && ids.has(ballot.voteFor))
    || DIMENSIONS.some((dim) => Object.values(ballot.scores).some((score) => score[dim] !== null)))

  const ranked = proposals.map((p) => {
    const t = totals.get(p.id)
    const dimensions = {}
    for (const dim of DIMENSIONS) {
      dimensions[dim] = t.dims[dim].weight ? t.dims[dim].sum / t.dims[dim].weight : 0
    }
    const otherDimensions = {}
    for (const dim of DIMENSIONS) {
      otherDimensions[dim] = t.otherDims[dim].weight ? t.otherDims[dim].sum / t.otherDims[dim].weight : 0
    }
    const average = weightedAverage(t.dims, dimensionWeights)
    const otherAverage = t.otherVotes ? weightedAverage(t.otherDims, dimensionWeights) : null
    const selfEvaluation = selfByProposal.get(p.id) || null
    const selfAverage = selfEvaluation ? selfEvaluation.overall : null
    const selfDelta = selfAverage !== null && otherAverage !== null ? Number((selfAverage - otherAverage).toFixed(2)) : null
    return {
      id: p.id,
      average,
      ...dimensions,
      scoredCount: t.otherVotes + (selfScorePolicy === 'exclude' ? 0 : t.selfVotes),
      selfVotes: t.selfVotes,
      otherVotes: t.otherVotes,
      selfAverage,
      otherAverage,
      selfDelta,
      first: t.first,
      condorcetWins: t.condorcetWins,
    }
  }).sort((a, b) => b.average - a.average || b.first - a.first || b.condorcetWins - a.condorcetWins || a.id.localeCompare(b.id))

  const condorcetWinner = validBallots.length
    ? ranked.find((row) => row.condorcetWins === Math.max(0, proposals.length - 1))
    : null
  const fallbackWinner = validBallots.length
    ? ranked.find((row) => row.scoredCount > 0 || row.first > 0)
    : null
  const selectedMethod = !validBallots.length
    ? 'no-valid-ballots'
    : requestedMethod === 'condorcet'
      ? (condorcetWinner ? 'condorcet' : 'no-condorcet-winner')
      : requestedMethod === 'weighted'
        ? 'weighted-average'
        : (condorcetWinner ? 'condorcet' : 'weighted-average-fallback')
  const winnerId = validBallots.length && selectedMethod !== 'no-condorcet-winner'
    ? (selectedMethod.startsWith('condorcet') ? condorcetWinner?.id || null : fallbackWinner?.id || null)
    : null
  const explain = {
    winner: winnerId,
    method: selectedMethod,
    requestedMethod,
    validBallots: validBallots.length,
    condorcetWinner: condorcetWinner?.id || null,
    fallbackWinner: fallbackWinner?.id || null,
    cycle: validBallots.length > 0 && !condorcetWinner && proposals.length > 2,
    steps: [
      { step: 'valid-ballots', value: validBallots.length, detail: `${ballots.length} submitted, ${validBallots.length} valid` },
      { step: 'condorcet', value: condorcetWinner?.id || null, detail: condorcetWinner ? 'majority pairwise winner' : 'no pairwise majority' },
      { step: 'fallback', value: fallbackWinner?.id || null, detail: 'highest weighted average among scored/first-place rows' },
      { step: 'winner', value: winnerId, detail: selectedMethod },
    ],
    rows: ranked.map((row) => ({
      id: row.id,
      average: row.average,
      first: row.first,
      scoredCount: row.scoredCount,
      condorcetWins: row.condorcetWins,
    })),
  }
  const audit = {
    schema: 'meetingbot/tally/v2',
    ballots: normalizedBallots,
    validBallots: validBallots.length,
    selfTransfers,
    selfAbstentions,
    selfEvaluations: selfEvaluations.map((evaluation) => {
      const row = ranked.find((item) => item.id === evaluation.proposal)
      return {
        ...evaluation,
        othersAverage: row?.otherAverage ?? null,
        delta: evaluation.overall !== null && row?.otherAverage !== null
          ? Number((evaluation.overall - row.otherAverage).toFixed(2)) : null,
      }
    }),
    selfScorePolicy,
    selfScoreWeight: selfScorePolicy === 'downweight' ? selfScoreWeight : 0,
    stripSelfFromRanking,
    voterTagBoost,
    pairwise,
    condensed: ranked.map((r) => ({
      id: r.id,
      average: r.average,
      first: r.first,
      scoredCount: r.scoredCount,
      condorcetWins: r.condorcetWins,
      dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, r[d]])),
      selfVotes: r.selfVotes,
      otherVotes: r.otherVotes,
      selfAverage: r.selfAverage,
      otherAverage: r.otherAverage,
      selfDelta: r.selfDelta,
    })),
    condorcetWinner: condorcetWinner?.id || null,
    cycle: validBallots.length > 0 && !condorcetWinner && proposals.length > 2,
    method: selectedMethod,
    explain,
    winner: winnerId,
    dimensionWeights,
  }
  return { winnerId, ranked, audit }
}
