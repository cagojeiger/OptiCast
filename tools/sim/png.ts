// Grayscale PNG writer for eyeballing simulator output.

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { crc32 } from '../../src/core/crc32.ts'
import type { GrayImage } from './vterm.ts'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function writePng(path: string, img: GrayImage): void {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, img.width)
  view.setUint32(4, img.height)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  const raw = new Uint8Array((img.width + 1) * img.height)
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1)
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]
  writeFileSync(path, Buffer.concat(parts))
}
