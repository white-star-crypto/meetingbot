#!/usr/bin/env node
import assert from 'node:assert/strict'
import { tally } from '../src/tally.mjs'

const proposals = [
  { id: 'P1', confidence: 0.8 },
  { id: 'P2', confidence: 0.7 },
  { id: 'P3', confidence: 0.6 },
]

function ballot(voter, ranking, scores, extra = {}) {
  return {
    voter,
    ranking,
    scores,
    voterTags: [],
    ...extra,
  }
}

// Condorcet winner: P1 beats P2 (2-1) and P3 (3-0).
const condorcet = tally(proposals, [
  ballot('a', ['P1', 'P2', 'P3'], {
    P1: { architecture: 8, aesthetics: 7, security: 9 },
    P2: { architecture: 7, aesthetics: 8, security: 7 },
    P3: { architecture: 5, aesthetics: 9, security: 6 },
  }),
  ballot('b', ['P1', 'P3', 'P2'], {
    P1: { architecture: 9, aesthetics: 6, security: 9 },
    P2: { architecture: 6, aesthetics: 7, security: 6 },
    P3: { architecture: 5, aesthetics: 8, security: 7 },
  }),
  ballot('c', ['P2', 'P1', 'P3'], {
    P1: { architecture: 8, aesthetics: 7, security: 8 },
    P2: { architecture: 8, aesthetics: 7, security: 7 },
    P3: { architecture: 4, aesthetics: 9, security: 5 },
  }),
])
assert.equal(condorcet.winnerId, 'P1')
assert.equal(condorcet.audit.method, 'condorcet')
assert.equal(condorcet.audit.condorcetWinner, 'P1')
assert.equal(condorcet.audit.pairwise.P1.P2, 2)

// Self-abstention transfer: the voter's own first choice moves to the next choice.
const selfTransfer = tally(proposals, [
  ballot('a', ['P1', 'P2', 'P3'], {
    P1: { architecture: 9, aesthetics: 9, security: 9 },
    P2: { architecture: 5, aesthetics: 5, security: 5 },
    P3: { architecture: 4, aesthetics: 4, security: 4 },
  }, { selfProposalId: 'P1', vote_for: 'P1' }),
])
assert.equal(selfTransfer.audit.selfTransfers.length, 1)
assert.equal(selfTransfer.audit.selfTransfers[0].to, 'P2')
assert.equal(selfTransfer.audit.ballots[0].voteFor, 'P2')

// Cycle: no Condorcet winner; weighted average is the deterministic fallback.
const cycleProposals = proposals
const cycle = tally(cycleProposals, [
  ballot('a', ['P1', 'P2', 'P3'], {
    P1: { architecture: 10, aesthetics: 5, security: 8 },
    P2: { architecture: 5, aesthetics: 10, security: 8 },
    P3: { architecture: 8, aesthetics: 8, security: 5 },
  }),
  ballot('b', ['P2', 'P3', 'P1'], {
    P1: { architecture: 10, aesthetics: 5, security: 8 },
    P2: { architecture: 5, aesthetics: 10, security: 8 },
    P3: { architecture: 8, aesthetics: 8, security: 5 },
  }),
  ballot('c', ['P3', 'P1', 'P2'], {
    P1: { architecture: 10, aesthetics: 5, security: 8 },
    P2: { architecture: 5, aesthetics: 10, security: 8 },
    P3: { architecture: 8, aesthetics: 8, security: 5 },
  }),
])
assert.equal(cycle.audit.cycle, true)
assert.equal(cycle.audit.method, 'weighted-average-fallback')
assert.ok(cycle.winnerId)

// Self scores must not inflate the overall ranking by default.
const two = proposals.slice(0, 2)
const selfScores = tally(two, [
  ballot('a', ['P2', 'P1'], {
    P1: { architecture: 10, aesthetics: 10, security: 10 },
    P2: { architecture: 1, aesthetics: 1, security: 1 },
  }, { selfProposalId: 'P1', vote_for: 'P2' }),
  ballot('b', ['P1', 'P2'], {
    P1: { architecture: 2, aesthetics: 2, security: 2 },
    P2: { architecture: 10, aesthetics: 10, security: 10 },
  }, { selfProposalId: 'P2', vote_for: 'P1' }),
], { selfScorePolicy: 'exclude' })
assert.equal(selfScores.winnerId, 'P1')
assert.equal(selfScores.ranked.find((r) => r.id === 'P1').average, 2)
assert.equal(selfScores.ranked.find((r) => r.id === 'P2').average, 1)
assert.equal(selfScores.audit.selfScorePolicy, 'exclude')
assert.equal(selfScores.audit.selfEvaluations.length, 2)
assert.equal(selfScores.audit.selfEvaluations[0].othersAverage, 2)
assert.equal(selfScores.audit.selfEvaluations[0].delta, 8)
assert.ok(selfScores.audit.ballots[0].scores.P1)
assert.deepEqual(selfScores.audit.ballots[0].pairRanking, ['P2'])

// Downweight is a deliberate alternative, not a silent include.
const downweighted = tally(two, [
  ballot('a', ['P1', 'P2'], {
    P1: { architecture: 10, aesthetics: 10, security: 10 },
    P2: { architecture: 2, aesthetics: 2, security: 2 },
  }, { selfProposalId: 'P1', vote_for: 'P1' }),
  ballot('b', ['P2', 'P1'], {
    P1: { architecture: 2, aesthetics: 2, security: 2 },
    P2: { architecture: 10, aesthetics: 10, security: 10 },
  }, { selfProposalId: 'P2', vote_for: 'P2' }),
], { selfScorePolicy: 'downweight', selfScoreWeight: 0.5 })
assert.equal(downweighted.audit.selfScorePolicy, 'downweight')
assert.equal(Math.round(downweighted.ranked.find((r) => r.id === 'P1').average * 100) / 100, 4.67)
assert.equal(downweighted.audit.selfEvaluations[0].selfWeight, 0.5)

// A ballot with no ranking and no scores must not become an alphabetical
// pairwise preference.
const scrap = tally(proposals, [ballot('x', [], {})])
for (const a of proposals) for (const b of proposals) {
  if (a.id !== b.id) assert.equal(scrap.audit.pairwise[a.id][b.id], 0)
}
assert.equal(scrap.audit.ballots[0].pairRanking.length, 0)
assert.equal(scrap.ranked[0].scoredCount, 0)

// No valid ballots must not produce an alphabetical winner.
const empty = tally(proposals, [])
assert.equal(empty.winnerId, null)
assert.equal(empty.audit.validBallots, 0)
assert.equal(empty.audit.method, 'no-valid-ballots')
assert.equal(scrap.winnerId, null)

// Null/undefined scores are missing votes, not real zeroes.
const nullScores = tally(two, [
  ballot('a', [], {
    P1: { architecture: null, aesthetics: undefined, security: '' },
    P2: { architecture: 8, aesthetics: 8, security: 8 },
  }),
])
assert.equal(nullScores.audit.validBallots, 1)
assert.equal(nullScores.ranked.find((r) => r.id === 'P1').scoredCount, 0)
assert.equal(nullScores.ranked.find((r) => r.id === 'P2').scoredCount, 1)
assert.equal(nullScores.winnerId, 'P2')

assert.equal(condorcet.audit.explain.winner, 'P1')
assert.equal(condorcet.audit.explain.steps.find((s) => s.step === 'valid-ballots').value, 3)
const weightedOnly = tally(proposals, [
  ballot('a', ['P1', 'P2', 'P3'], { P1: { architecture: 9, aesthetics: 9, security: 9 }, P2: { architecture: 8, aesthetics: 8, security: 8 }, P3: { architecture: 7, aesthetics: 7, security: 7 } }),
], { method: 'weighted' })
assert.equal(weightedOnly.audit.method, 'weighted-average')
assert.equal(weightedOnly.winnerId, 'P1')
const forcedCondorcet = tally(cycleProposals, [
  ballot('a', ['P1', 'P2', 'P3'], { P1: { architecture: 10, aesthetics: 5, security: 8 }, P2: { architecture: 5, aesthetics: 10, security: 8 }, P3: { architecture: 8, aesthetics: 8, security: 5 } }),
  ballot('b', ['P2', 'P3', 'P1'], { P1: { architecture: 10, aesthetics: 5, security: 8 }, P2: { architecture: 5, aesthetics: 10, security: 8 }, P3: { architecture: 8, aesthetics: 8, security: 5 } }),
  ballot('c', ['P3', 'P1', 'P2'], { P1: { architecture: 10, aesthetics: 5, security: 8 }, P2: { architecture: 5, aesthetics: 10, security: 8 }, P3: { architecture: 8, aesthetics: 8, security: 5 } }),
], { method: 'condorcet' })
assert.equal(forcedCondorcet.winnerId, null)
assert.equal(forcedCondorcet.audit.method, 'no-condorcet-winner')

console.log('PASS tally Condorcet / self-transfer / cycle fallback')
