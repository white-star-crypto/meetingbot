#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DECISION_SCHEMA, validateDecisionDocument } from '../src/decision-schema.mjs'

const valid = {
  schema: 'meetingbot/decision/v1',
  winner: 'P1',
  foreman: 'a',
  adopt: ['P1'],
  veto: [],
  canBuild: false,
  blocked: false,
  ownerGate: false,
  quorum: { valid: true, proposals: 2, validBallots: 2, minimum: 2 },
  buildGate: { status: 'unverified' },
}
assert.deepEqual(validateDecisionDocument(valid), [])
const unrequiredGate = { ...valid, canBuild: true, buildGate: { status: 'unverified', required: false } }
assert.deepEqual(validateDecisionDocument(unrequiredGate), [])

const bad = { ...valid, adopt: [], veto: [{ proposal: 'P1', category: 'vibe', reason: '' }], canBuild: true, ownerGate: true }
const errors = validateDecisionDocument(bad)
assert.ok(errors.some((error) => /winner must be in adopt|adopt must not be empty/.test(error)))
assert.ok(errors.some((error) => /invalid veto category/.test(error)))
assert.ok(errors.some((error) => /canBuild cannot be true/.test(error)))
const mockBypass = validateDecisionDocument({ ...valid, mockRun: true, canBuild: true })
assert.ok(mockBypass.some((error) => /canBuild cannot be true/.test(error)))
const badTypes = validateDecisionDocument({ ...valid, adopt: [1], veto: [{ proposal: 1, category: 'vibe', reason: '' }], buildGate: { status: 'maybe' }, quorum: { valid: 'yes', proposals: '2' } })
assert.ok(badTypes.some((error) => /adopt entries/.test(error)))
assert.ok(badTypes.some((error) => /buildGate.status/.test(error)))
const published = JSON.parse(fs.readFileSync(new URL('../schemas/decision.schema.json', import.meta.url), 'utf8'))
assert.deepEqual(published.properties.buildGate.properties.status.enum, DECISION_SCHEMA.properties.buildGate.properties.status.enum)
assert.deepEqual(Object.keys(published.properties).sort(), Object.keys(DECISION_SCHEMA.properties).sort())
console.log('PASS decision JSON-schema fail-closed invariants')
