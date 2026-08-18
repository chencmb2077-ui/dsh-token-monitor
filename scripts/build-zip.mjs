// build-zip.mjs — build the release zip asset (deflate) from the package files.
// Zero dependencies: plain Node (zlib). Usage:
//   node scripts/build-zip.mjs [outPath]
// Defaults to dist/dsh-token-monitor-<tag>.zip (tag from DSH_GH_TAG or v1.0.0).
// Also exported for reuse by publish-github.mjs.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TAG = process.env.DSH_GH_TAG || 'v1.0.0'
// The install zip carries exactly what you copy into $DSH_HOME/profiles/web/
// (the scripts are repo tooling, not runtime files).
const FILES = ['index.js', 'package.json', 'README.md', 'LICENSE', '.gitignore', 'cordis.patch.yml']

const crc32 = (buf) => zlib.crc32(buf) >>> 0

/**
 * Build a zip file from [{ name, buffer }] entries using the deflate method.
 * @param {Array<{name: string, buffer: Buffer}>} entries
 * @param {string} outPath
 * @returns {string} outPath
 */
export function buildZip(entries, outPath) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.buffer)
    const comp = zlib.deflateRawSync(e.buffer)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract
    local.writeUInt16LE(0x0800, 6) // general purpose: UTF-8 names
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(e.buffer.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(Buffer.concat([local, nameBuf, comp]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8) // UTF-8 names
    central.writeUInt16LE(8, 10) // method
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(e.buffer.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]))
    offset += local.length + nameBuf.length + comp.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir disk
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, Buffer.concat([...localParts, centralDir, eocd]))
  return outPath
}

// CLI entry when run directly: node scripts/build-zip.mjs [outPath]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outPath = process.argv[2] || path.join(REPO_ROOT, 'dist', `dsh-token-monitor-${TAG}.zip`)
  const entries = FILES.map((f) => ({ name: f, buffer: fs.readFileSync(path.join(REPO_ROOT, f)) }))
  const p = buildZip(entries, outPath)
  console.log('zip written:', p, `(${fs.statSync(p).size} bytes)`)
}
