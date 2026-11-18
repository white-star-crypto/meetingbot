#!/usr/bin/env node
// Build the portable ZIP without external dependencies.
//
// Windows' bundled bsdtar writes file names in the local code page (GBK here)
// while still setting the UTF-8 flag, so 合议.exe comes out as mojibake on any
// tool that trusts the flag. Compress-Archive writes backslashes. Both break
// the packaging gate and non-Windows unzip. This writer emits UTF-8 names,
// forward slashes and standard deflate entries.
//
// usage: node scripts/make-portable-zip.mjs <source-dir> <output.zip>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [sourceDir, outFile] = process.argv.slice(2)
if (!sourceDir || !outFile) {
  console.error('usage: node scripts/make-portable-zip.mjs <source-dir> <output.zip>')
  process.exit(2)
}
const root = path.resolve(sourceDir)
const out = path.resolve(outFile)
const files = []
const walk = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(absolute, name)
    else if (entry.isFile()) files.push({ absolute, name })
  }
}
walk(root, '')
files.sort((a, b) => a.name.localeCompare(b.name, 'en'))

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const dosTime = (date) => {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

const fd = fs.openSync(out, 'w')
const central = []
let offset = 0
const write = (buf) => { fs.writeSync(fd, buf, 0, buf.length, offset); offset += buf.length }
const UTF8_FLAG = 0x0800
let compressedBytes = 0
for (const file of files) {
  const data = fs.readFileSync(file.absolute)
  const crc = crc32(data)
  const stored = path.extname(file.name).toLowerCase() === '.pak'
  const body = stored ? data : zlib.deflateRawSync(data, { level: 6 })
  compressedBytes += body.length
  const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
  const stat = fs.statSync(file.absolute)
  const { time, day } = dosTime(stat.mtime)
  const method = stored ? 0 : 8
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(UTF8_FLAG, 6)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(day, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(body.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  const localOffset = offset
  write(header)
  write(name)
  write(body)
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(0x031e, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(UTF8_FLAG, 8)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(time, 12)
  cd.writeUInt16LE(day, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(body.length, 20)
  cd.writeUInt32LE(data.length, 24)
  cd.writeUInt16LE(name.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(0, 36)
  cd.writeUInt32LE(0, 38)
  cd.writeUInt32LE(localOffset, 42)
  central.push({ cd, name })
  if (files.length > 60000) throw new Error('zip64 required; this writer only handles the portable app layout')
}
const cdStart = offset
for (const entry of central) { write(entry.cd); write(entry.name) }
const cdSize = offset - cdStart
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(central.length, 8)
eocd.writeUInt16LE(central.length, 10)
eocd.writeUInt32LE(cdSize, 12)
eocd.writeUInt32LE(cdStart, 16)
eocd.writeUInt16LE(0, 20)
write(eocd)
fs.closeSync(fd)
console.log(`PASS wrote ${files.length} files · ${(offset / 1024 / 1024).toFixed(1)} MB · compressed payload ${(compressedBytes / 1024 / 1024).toFixed(1)} MB · ${out}`)
