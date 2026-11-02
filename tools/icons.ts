// App icons (web/icon-*.png): the frame's corner marks — three 7×7 finders and
// the small 5×5 one — on the receiver's background, inside the middle 60 % so
// the 512 px one also works as a maskable icon. Plain RGB PNG, no dependencies.
//
// usage: node tools/icons.ts   (writes web/icon-180.png, icon-192.png, icon-512.png)

import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const BG = [0x17, 0x17, 0x17]
const FG = [0x34, 0xd3, 0x99]
const SPAN = 17 // modules: finder 7 + gap 3 + finder 7

/** Module (x, y) of the 17×17 motif is lit. */
function lit(x: number, y: number): boolean {
  const finder = (fx: number, fy: number, n: number) => {
    const [dx, dy] = [x - fx, y - fy]
    if (dx < 0 || dy < 0 || dx >= n || dy >= n) return null
    const ring = Math.min(dx, dy, n - 1 - dx, n - 1 - dy)
    return ring !== 1 // outer ring and centre lit, the ring between dark
  }
  return finder(0, 0, 7) ?? finder(10, 0, 7) ?? finder(0, 10, 7) ?? finder(11, 11, 5) ?? false
}

function png(size: number): Buffer {
  const module = Math.floor((size * 0.6) / SPAN)
  const origin = Math.floor((size - module * SPAN) / 2)
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [mx, my] = [Math.floor((x - origin) / module), Math.floor((y - origin) / module)]
      const on = x >= origin && y >= origin && mx < SPAN && my < SPAN && lit(mx, my)
      raw.set(on ? FG : BG, y * (size * 3 + 1) + 1 + x * 3)
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

for (const size of [180, 192, 512]) writeFileSync(`web/icon-${size}.png`, png(size))
