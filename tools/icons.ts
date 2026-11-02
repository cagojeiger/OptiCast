// App icons (web/icon-*.png) and the favicon (web/icon.svg): a lens ring with the
// grid the camera reads inside it, black and white only (DESIGN.md): the icon is
// identity, green on the page is a status signal, and the two stay apart. The motif
// sits inside the middle 70 % so the 512 px one also works as a maskable icon.
// Plain RGB PNG with 4× supersampling, no dependencies.
//
// usage: node tools/icons.ts   (writes web/icon.svg, icon-180.png, icon-192.png, icon-512.png)

import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const BG = [0x0a, 0x0a, 0x0a]
const RING = [0xff, 0xff, 0xff]
const GRID = [0xff, 0xff, 0xff]

// Geometry in a 100-unit box: ring centre (50, 50), radius 34, stroke 6; five 8-unit cells.
const RING_R = 34
const RING_W = 6
const CELLS: [number, number][] = [[37, 37], [55, 37], [46, 46], [37, 55], [55, 55]]
const CELL = 8

/** Colour at (x, y) in the 100-unit box. */
function colour(x: number, y: number): number[] {
  for (const [cx, cy] of CELLS) if (x >= cx && x < cx + CELL && y >= cy && y < cy + CELL) return GRID
  const d = Math.hypot(x - 50, y - 50)
  if (Math.abs(d - RING_R) <= RING_W / 2) return RING
  return BG
}

function png(size: number): Buffer {
  const ss = 4 // samples per axis per pixel
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = colour(((x + (sx + 0.5) / ss) / size) * 100, ((y + (sy + 0.5) / ss) / size) * 100)
          r += c[0]!
          g += c[1]!
          b += c[2]!
        }
      const acc = [r, g, b]
      raw.set(acc.map((v) => Math.round(v / (ss * ss))), y * (size * 3 + 1) + 1 + x * 3)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${hex(BG)}"/>` +
  `<circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="${hex(RING)}" stroke-width="${RING_W}"/>` +
  `<g fill="${hex(GRID)}">${CELLS.map(([x, y]) => `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}"/>`).join('')}</g></svg>\n`
writeFileSync('web/icon.svg', svg)
for (const size of [180, 192, 512]) writeFileSync(`web/icon-${size}.png`, png(size))
console.log('icons    web/icon.svg, icon-180.png, icon-192.png, icon-512.png')
