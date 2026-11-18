#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractBriefImages, imageMarkdownPaths, supportsImages, withBriefImages } from '../src/multimodal.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heyi-multimodal-'))
const png = path.join(tmp, 'shot.png')
await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=', 'base64'))
try {
  const brief = `# UI\n\n![home](${png})\n\nKeep it simple.`
  assert.deepEqual(imageMarkdownPaths(brief), [{ alt: 'home', src: png }])
  const extracted = await extractBriefImages(brief, tmp)
  assert.equal(extracted.images.length, 1)
  assert.equal(extracted.images[0].mime, 'image/png')
  assert.ok(extracted.images[0].dataUrl.startsWith('data:image/png;base64,'))
  const messages = [{ role: 'user', content: 'look' }]
  const multimodal = withBriefImages(messages, extracted.images, { tags: ['multimodal'] })
  assert.ok(Array.isArray(multimodal[0].content))
  assert.equal(multimodal[0].content[0].type, 'text')
  assert.equal(multimodal[0].content[1].type, 'image_url')
  const textOnly = withBriefImages(messages, extracted.images, { tags: [] })
  assert.equal(typeof textOnly[0].content, 'string')
  assert.match(textOnly[0].content, /未标记 multimodal/)
  assert.equal(supportsImages({ tags: ['multimodal'] }), true)
  const fileUrl = await extractBriefImages(`![file](${pathToFileURL(png).href})`, tmp)
  assert.equal(fileUrl.images.length, 1)
  assert.equal(fileUrl.images[0].mime, 'image/png')
  const escaped = await extractBriefImages(`![outside](${path.join(tmp, '..', 'outside.png')})`, tmp)
  assert.equal(escaped.images.length, 0)
  assert.ok(escaped.warnings.some((warning) => warning.includes('越出')))
  console.log('PASS brief image extraction, multimodal message shape, path boundary')
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
