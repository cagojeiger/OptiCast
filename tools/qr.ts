// The receiver address as a QR code (web/qr.svg) for the desktop setup page, so a
// phone can scan it instead of typing. A plain byte-mode encoder, error correction
// level M, the smallest version that fits; no dependencies. Encoder per ISO/IEC
// 18004: data codewords → RS parity → interleave → place → mask with the best penalty.
//
// usage: node tools/qr.ts [url]   (writes web/qr.svg)

import { writeFileSync } from 'node:fs'

const URL_DEFAULT = 'https://cagojeiger.github.io/diodecam/'
const EC = 'M'

// --- tables (versions 1–10 are plenty for a short URL) ----------------------------
// [total codewords, ec codewords per block, blocks in group 1, data codewords per block, blocks in group 2]
const PARAMS: Record<string, number[][]> = {
  M: [[26, 10, 1, 16, 0], [44, 16, 1, 28, 0], [70, 26, 1, 44, 0], [100, 18, 2, 32, 0], [134, 24, 2, 43, 0], [172, 16, 4, 27, 0], [196, 18, 4, 31, 0], [242, 22, 2, 38, 2], [292, 22, 3, 36, 2], [346, 26, 4, 43, 1]],
}
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
const EC_BITS: Record<string, number> = { L: 1, M: 0, Q: 3, H: 2 }

// --- GF(256) ---------------------------------------------------------------------
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x = x << 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0)

function rsParity(data: number[], n: number): number[] {
  let gen = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] ?? 0) ^ gen[j]!
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(gen[j]!, EXP[i]!)
    }
    gen = next
  }
  const rem = new Array<number>(n).fill(0)
  for (const d of data) {
    const f = d ^ rem[0]!
    rem.shift()
    rem.push(0)
    if (f) for (let j = 0; j < n; j++) rem[j] = (rem[j] ?? 0) ^ mul(gen[j + 1]!, f)
  }
  return rem
}

// --- bit stream, version choice, codewords ---------------------------------------
function codewords(text: string, ec: string): { version: number; words: number[] } {
  const bytes = [...Buffer.from(text, 'utf8')]
  for (let v = 1; v <= 10; v++) {
    const [total, ecPer, g1, d1, g2] = PARAMS[ec]![v - 1]!
    const dataWords = g1! * d1! + g2! * (d1! + 1)
    const countBits = v <= 9 ? 8 : 16
    const needBits = 4 + countBits + bytes.length * 8
    if (needBits > dataWords * 8) continue
    const bits: number[] = []
    const push = (val: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1)
    }
    push(0b0100, 4)
    push(bytes.length, countBits)
    for (const b of bytes) push(b, 8)
    push(0, Math.min(4, dataWords * 8 - bits.length))
    while (bits.length % 8) bits.push(0)
    const data: number[] = []
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
    for (let pad = 0xec; data.length < dataWords; pad ^= 0xec ^ 0x11) data.push(pad)
    // blocks
    const blocks: number[][] = []
    let at = 0
    for (let b = 0; b < g1!; b++, at += d1!) blocks.push(data.slice(at, at + d1!))
    for (let b = 0; b < g2!; b++, at += d1! + 1) blocks.push(data.slice(at, at + d1! + 1))
    const parity = blocks.map((blk) => rsParity(blk, ecPer!))
    const words: number[] = []
    const maxLen = Math.max(...blocks.map((b) => b.length))
    for (let i = 0; i < maxLen; i++) for (const blk of blocks) if (i < blk.length) words.push(blk[i]!)
    for (let i = 0; i < ecPer!; i++) for (const p of parity) words.push(p[i]!)
    if (words.length !== total) throw new Error('codeword count')
    return { version: v, words }
  }
  throw new Error('too long for version 10')
}

// --- matrix ----------------------------------------------------------------------
function matrix(version: number, words: number[], ec: string): number[][] {
  const n = version * 4 + 17
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(-1)) // -1 = free
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < n && y < n) m[y]![x] = v
  }
  const finder = (cx: number, cy: number) => {
    // 7×7 mark with its 1-module light separator: rings dark, light, dark, light centre dark.
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, d === 4 || d === 2 ? 0 : 1)
      }
  }
  finder(3, 3)
  finder(n - 4, 3)
  finder(3, n - 4)
  for (const cy of ALIGN[version - 1]!)
    for (const cx of ALIGN[version - 1]!) {
      if (m[cy]![cx] !== -1) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 0 : 1)
    }
  for (let i = 8; i < n - 8; i++) {
    set(i, 6, i % 2 === 0 ? 1 : 0)
    set(6, i, i % 2 === 0 ? 1 : 0)
  }
  set(8, n - 8, 1) // dark module
  // Format strips are written after masking; they are not data cells.
  const reserved = new Set<string>()
  for (let i = 0; i < 9; i++) for (const [x, y] of [[i, 8], [8, i]] as const) reserved.add(`${x},${y}`)
  for (let i = 0; i < 8; i++) for (const [x, y] of [[n - 1 - i, 8], [8, n - 1 - i]] as const) reserved.add(`${x},${y}`)
  const isData = (x: number, y: number) => !reserved.has(`${x},${y}`) && !fixed(x, y, n, version)
  // place data
  const bits: number[] = []
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1)
  let bi = 0
  let up = true
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k
      for (const x of [col, col - 1]) if (isData(x, y)) m[y]![x] = bits[bi++] ?? 0
    }
    up = !up
  }
  // choose the mask with the lowest penalty
  let best: number[][] = m
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const c = m.map((row) => row.slice())
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (isData(x, y) && maskBit(mask, x, y)) c[y]![x] = (c[y]![x] ?? 0) ^ 1
    writeFormat(c, ec, mask, n)
    const s = penalty(c)
    if (s < bestScore) {
      bestScore = s
      best = c
    }
  }
  return best
}

function fixed(x: number, y: number, n: number, version: number): boolean {
  const inFinder = (cx: number, cy: number) => Math.abs(x - cx) <= 4 && Math.abs(y - cy) <= 4
  if (inFinder(3, 3) || inFinder(n - 4, 3) || inFinder(3, n - 4)) return true
  if (x === 6 || y === 6) return true
  if (x === 8 && y === n - 8) return true
  for (const cy of ALIGN[version - 1]!)
    for (const cx of ALIGN[version - 1]!) {
      const overlapsFinder = (cx < 9 && cy < 9) || (cx > n - 10 && cy < 9) || (cx < 9 && cy > n - 10)
      if (!overlapsFinder && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true
    }
  return false
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function writeFormat(m: number[][], ec: string, mask: number, n: number) {
  let data = (EC_BITS[ec]! << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10)
  const bits = ((data << 10) | rem) ^ 0b101010000010010
  const bit = (i: number) => (bits >> i) & 1
  for (let i = 0; i < 6; i++) m[8]![i] = bit(14 - i)
  m[8]![7] = bit(8)
  m[8]![8] = bit(7)
  m[7]![8] = bit(6)
  for (let i = 0; i < 6; i++) m[5 - i]![8] = bit(5 - i)
  for (let i = 0; i < 8; i++) m[n - 1 - i]![8] = bit(14 - i)
  for (let i = 0; i < 7; i++) m[8]![n - 7 + i] = bit(6 - i)
  m[n - 8]![8] = 1
}

function penalty(m: number[][]): number {
  const n = m.length
  let s = 0
  for (let y = 0; y < n; y++) {
    let run = 1
    for (let x = 1; x <= n; x++) {
      if (x < n && m[y]![x] === m[y]![x - 1]) run++
      else {
        if (run >= 5) s += run - 2
        run = 1
      }
    }
  }
  for (let x = 0; x < n; x++) {
    let run = 1
    for (let y = 1; y <= n; y++) {
      if (y < n && m[y]![x] === m[y - 1]![x]) run++
      else {
        if (run >= 5) s += run - 2
        run = 1
      }
    }
  }
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) if (m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) s += 3
  const pat = [1, 0, 1, 1, 1, 0, 1]
  const lines = [...m, ...m[0]!.map((_, x) => m.map((row) => row[x]!))]
  for (const line of lines)
    for (let i = 0; i + 7 <= line.length; i++) {
      if (pat.every((p, k) => line[i + k] === p)) {
        const before = line.slice(Math.max(0, i - 4), i).every((v) => v === 0) && i >= 4
        const after = line.slice(i + 7, i + 11).every((v) => v === 0) && i + 11 <= line.length
        if (before || after) s += 40
      }
    }
  const dark = m.flat().filter((v) => v === 1).length
  s += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return s
}

// --- SVG -------------------------------------------------------------------------
function svg(m: number[][]): string {
  const n = m.length
  const q = 4 // quiet zone
  let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y]![x] === 1) d += `M${x + q} ${y + q}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${URL_DEFAULT}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#171717"/></svg>\n`
}

const url = process.argv[2] ?? URL_DEFAULT
const { version, words } = codewords(url, EC)
const m = matrix(version, words, EC)
writeFileSync('web/qr.svg', svg(m))
console.log(`qr       web/qr.svg  version ${version} (${m.length}×${m.length}), ${url}`)
