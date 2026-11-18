#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reviewImage } from '../src/vision-guard.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-vision-fence-'))
const outside = path.join(root, 'outside.png')
const allowed = path.join(root, 'inside')
await fs.mkdir(allowed, { recursive: true })
const inside = path.join(allowed, 'inside.png')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=', 'base64')
await fs.writeFile(outside, png)
await fs.writeFile(inside, png)
try {
  await assert.rejects(
    () => reviewImage({ config: { participants: [] }, imagePath: outside, allowedRoots: [allowed] }),
    /outside the allowed workspace/,
  )
  await assert.rejects(
    () => reviewImage({ config: { participants: [] }, imagePath: inside, allowedRoots: [allowed] }),
    /no multimodal model/,
  )
  console.log('PASS vision review path fence blocks outside-workspace files')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
