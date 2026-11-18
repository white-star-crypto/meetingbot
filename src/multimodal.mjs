import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const IMAGE_MD = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export function imageMarkdownPaths(brief) {
  const out = []
  for (const match of String(brief || '').matchAll(IMAGE_MD)) {
    const src = String(match[2] || '').trim()
    if (src) out.push({ alt: String(match[1] || '').trim(), src })
  }
  return out
}

export async function extractBriefImages(brief, baseDir, { maxImages = 4, maxBytes = 12 * 1024 * 1024 } = {}) {
  const root = path.resolve(baseDir || process.cwd())
  const allowedRoots = [root, path.resolve(process.cwd())]
  const images = []
  const warnings = []
  for (const ref of imageMarkdownPaths(brief)) {
    if (images.length >= maxImages) {
      warnings.push(`图片超过 ${maxImages} 张，已忽略其余引用`)
      break
    }
    const windowsDrive = /^[a-z]:[\\/]/i.test(ref.src)
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref.src) && !ref.src.startsWith('file://') && !windowsDrive) {
      warnings.push(`只读取本地图片，已跳过：${ref.src.slice(0, 160)}`)
      continue
    }
    let rawPath = ref.src
    if (ref.src.startsWith('file://')) {
      try { rawPath = fileURLToPath(ref.src) } catch { warnings.push(`file:// 路径无法解析，已跳过：${ref.src.slice(0, 160)}`); continue }
    }
    const candidates = path.isAbsolute(rawPath)
      ? [rawPath]
      : [path.resolve(root, rawPath), path.resolve(process.cwd(), rawPath)]
    let absolute = ''
    for (const candidate of [...new Set(candidates)]) {
      if (!allowedRoots.some((allowed) => candidate === allowed || candidate.startsWith(allowed + path.sep))) continue
      if (!MIME[path.extname(candidate).toLowerCase()]) continue
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile() && stat.size <= maxBytes) { absolute = candidate; break }
      } catch { /* try the next candidate */ }
    }
    if (!absolute) {
      warnings.push(`图片不可读或路径越出允许目录，已跳过：${rawPath}`)
      continue
    }
    const ext = path.extname(absolute).toLowerCase()
    try {
      const b64 = (await fs.readFile(absolute)).toString('base64')
      images.push({ alt: ref.alt, path: absolute, mime: MIME[ext], dataUrl: `data:${MIME[ext]};base64,${b64}` })
    } catch (error) {
      warnings.push(`图片读取失败，已跳过：${rawPath}（${String(error?.message || error)}）`)
    }
  }
  return { images, warnings }
}

export function supportsImages(participant) {
  return Array.isArray(participant?.tags) && participant.tags.includes('multimodal')
}

export function withBriefImages(messages, images = [], participant) {
  if (!Array.isArray(images) || !images.length) return messages
  const copy = messages.map((message) => ({ ...message }))
  const last = copy[copy.length - 1]
  if (!last || last.role !== 'user') return copy
  const text = String(last.content || '')
  if (!supportsImages(participant)) {
    last.content = `${text}\n\n（Brief 引用了 ${images.length} 张本地图片，但当前模型未标记 multimodal；请只依据文字，不要猜测图片内容。）`
    return copy
  }
  last.content = [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: image.dataUrl },
    })),
  ]
  return copy
}
