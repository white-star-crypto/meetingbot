#!/usr/bin/env node
import assert from 'node:assert/strict'
import { decisionMessages, sanitizeVotesForForeman, validateDecision } from '../src/meeting.mjs'

const proposals = [
  { id: 'P1', understanding: 'one', architecture: 'a1', aesthetic: 'v1', risks: [], confidence: 0.8 },
  { id: 'P2', understanding: 'two', architecture: 'a2', aesthetic: 'v2', risks: [], confidence: 0.7 },
]
const votes = {
  winner: 'P1',
  foreman: 'agent-a',
  electedForeman: 'agent-a',
  missing: ['agent-z'],
  ranked: [{ id: 'P1', average: 8 }, { id: 'P2', average: 7 }],
  rows: [
    { voter: 'agent-a', voterTags: ['code'], selfProposalId: 'P1', fallback: true, replacedAgent: 'agent-x', vote_for: 'P2', scores: { P1: {}, P2: {} }, reason: 'r1' },
    { voter: 'agent-b', selfProposalId: 'P2', vote_for: 'P1', scores: { P1: {}, P2: {} }, reason: 'r2' },
  ],
  tallyAudit: {
    ballots: [
      { voter: 'agent-a', selfProposalId: 'P1', voteFor: 'P2' },
      { voter: 'agent-b', selfProposalId: 'P2', voteFor: 'P1' },
    ],
    selfEvaluations: [{ voter: 'agent-a', proposal: 'P1', overall: 9 }],
    selfTransfers: [{ voter: 'agent-a', from: 'P1', to: 'P2' }],
    selfAbstentions: [{ voter: 'agent-b', proposal: 'P2' }],
  },
}

const sanitized = sanitizeVotesForForeman(votes)
assert.equal('voter' in sanitized.rows[0], false)
assert.equal('selfProposalId' in sanitized.rows[0], false)
assert.equal('voterTags' in sanitized.rows[0], false)
assert.equal('fallback' in sanitized.rows[0], false)
assert.equal('replacedAgent' in sanitized.rows[0], false)
assert.equal('foreman' in sanitized, false)
assert.equal('electedForeman' in sanitized, false)
assert.equal('missing' in sanitized, false)
assert.equal('voter' in sanitized.tallyAudit.ballots[0], false)
assert.equal(sanitized.tallyAudit.selfEvaluations.length, 0)
assert.equal(sanitized.tallyAudit.selfTransfers.length, 0)
assert.equal(sanitized.tallyAudit.selfAbstentions.length, 0)
assert.equal('foremanDebateDigest' in sanitized, false)

const electedPrompt = JSON.stringify(decisionMessages('brief', proposals, votes, 'P1'))
assert.match(electedPrompt, /authors hidden/)
assert.match(electedPrompt, /at most 1 veto/)
assert.match(electedPrompt, /Veto entries MUST be objects/)
assert.match(electedPrompt, /safety, scope, budget, infeasible, conflict/)
assert.match(electedPrompt, /category.*scope/)
assert.equal(electedPrompt.includes('agent-a'), false)
assert.equal(electedPrompt.includes('selfProposalId'), false)

const actingPrompt = JSON.stringify(decisionMessages('brief', proposals, votes, 'P1', '', '', {
  actingForeman: { id: 'agent-b' },
  freezeVeto: true,
}))
assert.match(actingPrompt, /Veto power is frozen/)
assert.match(actingPrompt, /Elected proposal: P1/)
assert.equal(actingPrompt.includes('agent-b'), false)

const frozen = validateDecision({
  adopt: ['P2'],
  veto: [{ proposal: 'P1', category: 'scope', reason: 'x' }],
}, proposals, 'P1', { freezeVeto: true, maxVetoes: 1 })
assert.deepEqual(frozen.adopt, ['P1', 'P2'])
assert.deepEqual(frozen.veto, [])
assert.ok(frozen.warnings.some((w) => /both adopted and vetoed|frozen/.test(w)))

const limited = validateDecision({
  adopt: ['P1'],
  veto: [
    { proposal: 'P2', category: 'scope', reason: 'x' },
    { proposal: 'P2', category: 'safety', reason: 'y' },
  ],
}, proposals, 'P1', { maxVetoes: 1 })
assert.equal(limited.veto.length, 1)
assert.ok(limited.warnings.some((w) => /veto limit/.test(w)))

const winnerVeto = validateDecision({
  adopt: [],
  veto: [{ proposal: 'P1', category: 'scope', reason: 'contradicts the winner' }],
}, proposals, 'P1', { maxVetoes: 1 })
assert.deepEqual(winnerVeto.adopt, ['P1'])
assert.deepEqual(winnerVeto.veto, [])
assert.ok(winnerVeto.warnings.some((w) => /both adopted and vetoed/.test(w)))

console.log('PASS decision anonymity / failover veto freeze / veto limit')
