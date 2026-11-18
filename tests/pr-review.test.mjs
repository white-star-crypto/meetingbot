#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildPrReviewBrief } from '../src/pr-review.mjs'

const diff = `diff --git a/src/a.mjs b/src/a.mjs
index 1111111..2222222 100644
--- a/src/a.mjs
+++ b/src/a.mjs
@@ -1,2 +1,3 @@
 const a = 1
+const b = 2
 export { a, b }
`
const brief = buildPrReviewBrief({ diff, title: 'audit fix', base: 'main', head: 'HEAD' })
assert.match(brief, /^# Brief — PR review/)
assert.match(brief, /src\/a\.mjs/)
assert.match(brief, /Do not invent code/)
assert.match(brief, /^```diff$/m)
assert.throws(() => buildPrReviewBrief({ diff: '   ' }), /empty/)
const clipped = buildPrReviewBrief({ diff: 'x'.repeat(100), maxDiffChars: 20 })
assert.match(clipped, /已截断/)
console.log('PASS PR review brief construction, file list, truncation, empty guard')
