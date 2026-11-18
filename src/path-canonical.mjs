import fs from 'node:fs'
import path from 'node:path'

// Resolve a path to the location a write would actually land on, even when the
// final component does not exist yet. Symlinks in existing parent components
// are resolved; a dangling final symlink remains the link itself.
export function canonicalPath(target) {
  const absolute = path.resolve(target)
  if (fs.existsSync(absolute)) {
    try { return fs.realpathSync.native(absolute) } catch { return absolute }
  }
  let current = absolute
  const tail = []
  while (current !== path.dirname(current)) {
    tail.unshift(path.basename(current))
    current = path.dirname(current)
    if (fs.existsSync(current)) break
  }
  let base = current
  try { base = fs.realpathSync.native(current) } catch {}
  return path.join(base, ...tail)
}
