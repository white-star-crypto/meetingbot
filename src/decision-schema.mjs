export const DECISION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://meetingbot.local/schemas/decision.v1.json',
  title: 'MeetingBot decision v1',
  type: 'object',
  required: ['schema', 'winner', 'foreman', 'adopt', 'veto', 'canBuild', 'blocked', 'ownerGate', 'quorum', 'buildGate'],
  properties: {
    schema: { const: 'meetingbot/decision/v1' },
    winner: { type: 'string', minLength: 1 },
    foreman: { type: ['string', 'null'] },
    electedForeman: { type: ['string', 'null'] },
    actingForeman: { type: ['string', 'null'] },
    adopt: { type: 'array', items: { type: 'string' }, minItems: 1 },
    veto: {
      type: 'array',
      items: {
        type: 'object',
        required: ['proposal', 'category', 'reason'],
        properties: {
          proposal: { type: 'string' },
          category: { enum: ['safety', 'scope', 'budget', 'infeasible', 'conflict'] },
          reason: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    canBuild: { type: 'boolean' },
    blocked: { type: 'boolean' },
    ownerGate: { type: 'boolean' },
    failover: { type: 'boolean' },
    fallback: { type: 'boolean' },
    parentRunId: { type: ['string', 'null'] },
    mockRun: { type: 'boolean' },
    repairRequiresGate: { type: 'boolean' },
    quorum: {
      type: 'object',
      required: ['valid', 'proposals'],
      properties: {
        valid: { type: 'boolean' },
        proposals: { type: 'integer', minimum: 0 },
        validBallots: { type: 'integer', minimum: 0 },
        minimum: { type: 'integer', minimum: 0 },
        missing: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
    buildGate: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { enum: ['skipped', 'passed', 'failed', 'unverified', 'blocked'] },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function checkType(value, expected, path, errors) {
  const types = Array.isArray(expected) ? expected : [expected]
  const actual = typeOf(value)
  if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
    errors.push(`${path}: expected ${types.join('|')}, got ${actual}`)
    return false
  }
  return true
}

export function isBuildGateSatisfied(decision) {
  return decision?.buildGate?.status === 'passed'
    || (decision?.buildGate?.required === false && decision?.buildGate?.status === 'unverified')
}

export function validateDecisionDocument(decision) {
  const errors = []
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return ['decision must be an object']
  for (const key of DECISION_SCHEMA.required) {
    if (!(key in decision)) errors.push(`missing ${key}`)
  }
  if (checkType(decision.schema, 'string', 'schema', errors) && decision.schema !== 'meetingbot/decision/v1') {
    errors.push('schema must be meetingbot/decision/v1')
  }
  if (checkType(decision.winner, 'string', 'winner', errors) && !decision.winner) errors.push('winner must not be empty')
  checkType(decision.foreman, ['string', 'null'], 'foreman', errors)
  for (const [key, types] of [
    ['electedForeman', ['string', 'null']],
    ['actingForeman', ['string', 'null']],
    ['failover', 'boolean'],
    ['fallback', 'boolean'],
    ['parentRunId', ['string', 'null']],
    ['mockRun', 'boolean'],
    ['repairRequiresGate', 'boolean'],
  ]) {
    if (key in decision) checkType(decision[key], types, key, errors)
  }
  checkType(decision.adopt, 'array', 'adopt', errors)
  checkType(decision.veto, 'array', 'veto', errors)
  checkType(decision.canBuild, 'boolean', 'canBuild', errors)
  checkType(decision.blocked, 'boolean', 'blocked', errors)
  checkType(decision.ownerGate, 'boolean', 'ownerGate', errors)
  checkType(decision.quorum, 'object', 'quorum', errors)
  checkType(decision.buildGate, 'object', 'buildGate', errors)
  const adopt = Array.isArray(decision.adopt) ? decision.adopt : []
  const veto = Array.isArray(decision.veto) ? decision.veto : []
  if (adopt.some((item) => typeof item !== 'string')) errors.push('adopt entries must be strings')
  if (!adopt.length) errors.push('adopt must not be empty')
  if (decision.quorum && typeof decision.quorum === 'object') {
    if (typeof decision.quorum.valid !== 'boolean') errors.push('quorum.valid must be boolean')
    if (!Number.isInteger(decision.quorum.proposals) || decision.quorum.proposals < 0) errors.push('quorum.proposals must be a non-negative integer')
    if (decision.quorum.validBallots !== undefined && (!Number.isInteger(decision.quorum.validBallots) || decision.quorum.validBallots < 0)) errors.push('quorum.validBallots must be a non-negative integer')
  }
  if (decision.buildGate && typeof decision.buildGate === 'object') {
    if (!['skipped', 'passed', 'failed', 'unverified', 'blocked'].includes(decision.buildGate.status)) errors.push('buildGate.status must be skipped|passed|failed|unverified|blocked')
  }
  if (decision.winner && !adopt.includes(decision.winner)) errors.push('winner must be in adopt')
  for (const item of veto) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('veto entries must be objects'); continue }
    if (typeof item.proposal !== 'string') errors.push('veto.proposal must be a string')
    if (!['safety', 'scope', 'budget', 'infeasible', 'conflict'].includes(item.category)) errors.push(`invalid veto category: ${item.category}`)
    if (!String(item.reason || '').trim()) errors.push(`veto ${item.proposal} has empty reason`)
    if (adopt.includes(item.proposal)) errors.push(`veto target ${item.proposal} is also adopted`)
  }
  if (decision.quorum?.valid !== true && decision.canBuild === true) errors.push('canBuild cannot be true when quorum is invalid')
  if (!isBuildGateSatisfied(decision) && decision.canBuild === true) errors.push('canBuild cannot be true unless the build gate passed (or was not required)')
  if ((decision.blocked === true || decision.ownerGate === true) && decision.canBuild === true) errors.push('canBuild cannot be true when blocked or ownerGate is set')
  if ((decision.fallback === true || decision.repairRequiresGate === true) && decision.canBuild === true) errors.push('canBuild cannot be true for fallback/repair decisions')
  if (decision.foreman == null && decision.ownerGate !== true) errors.push('null foreman requires ownerGate=true')
  return [...new Set(errors)]
}
