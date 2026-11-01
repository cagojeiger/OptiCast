// Optical path: frame bytes -> QR -> the sender's real ANSI output -> virtual
// terminal pixels -> synthetic camera -> jsQR (the receiver's decoder) -> bytes.

import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { prepareTransfer } from '../src/core/index.ts'
import { fitVersion, geometry } from '../src/sender/plan.ts'
import { byteCapacity, encodeSymbol, type Ecc } from '../src/sender/qr.ts'
import { composeScreen, fitWidth, renderSymbol, type RenderMode } from '../src/sender/terminal.ts'
import { denoise } from '../src/receiver/preprocess.ts'
import { cameraView, downscale2x, framing, toRgba, type CameraOptions } from '../tools/sim/camera.ts'
import { VTerm, type GrayImage, type RasterOptions } from '../tools/sim/vterm.ts'
import { randomBytes } from './helpers.ts'

function screenImage(bytes: Uint8Array, version: number, ecc: Ecc, mode: RenderMode, raster: RasterOptions = {}): GrayImage {
  const geo = geometry(version, { ecc, quiet: 2, mode })
  const term = { cols: geo.footprint.cols + 10, rows: geo.footprint.rows + 3 }
  const vt = new VTerm(term)
  vt.write(composeScreen(renderSymbol(encodeSymbol(bytes, version, ecc), 2, mode), geo.footprint, term, ' OptiCast  status line'))
  return vt.rasterize(raster)
}

/** The receiver's path: optional denoise, then jsQR. */
function decode(img: GrayImage, smooth = true): Uint8Array | null {
  const rgba = toRgba(img)
  if (smooth) denoise(rgba, img.width, img.height)
  const code = jsQR(rgba, img.width, img.height, { inversionAttempts: 'dontInvert' })
  return code ? new Uint8Array(code.binaryData) : null
}

/** A 1920×1080 phone frame, downscaled to the receiver's 960 scan size. */
function shoot(screen: GrayImage, opts: Partial<CameraOptions> = {}): GrayImage {
  const width = 1920
  const height = 1080
  return downscale2x(cameraView(screen, { width, height, corners: framing(width, height, screen.width / screen.height), ...opts }))
}

describe('QR capacity', () => {
  it('matches the QR byte-mode capacity table', () => {
    expect(byteCapacity(1, 'L')).toBe(17)
    expect(byteCapacity(1, 'M')).toBe(14)
    expect(byteCapacity(10, 'M')).toBe(213)
    expect(byteCapacity(40, 'L')).toBe(2953)
  })
})

describe('status line width', () => {
  it('truncates by display columns, counting Hangul as two', () => {
    expect(fitWidth('abc', 10)).toBe('abc')
    expect(fitWidth('결재승인보고서.json', 10)).toBe('결재승인보')
    expect(fitWidth('결재승인보고서.json', 11)).toBe('결재승인보')
  })
})

describe('terminal fit', () => {
  it('picks the largest version that fits above the status row', () => {
    const opts = { ecc: 'M' as const, quiet: 2, mode: 'half' as const }
    expect(fitVersion({ cols: 80, rows: 24 }, 40, opts)).toBe(6) // 45 cols x 23 rows
    expect(fitVersion({ cols: 200, rows: 60 }, 10, opts)).toBe(10) // capped
    expect(fitVersion({ cols: 80, rows: 24 }, 40, { ...opts, mode: 'bg' })).toBeNull() // bg halves vertical density
    expect(fitVersion({ cols: 120, rows: 40 }, 40, { ...opts, mode: 'bg' })).toBe(4)
    expect(fitVersion({ cols: 10, rows: 5 }, 40, opts)).toBeNull()
  })
})

describe('optical round trip', async () => {
  const transfer = await prepareTransfer(randomBytes(2000), { filename: 'sample.bin', blockSize: geometry(10, { ecc: 'M', quiet: 2, mode: 'half' }).blockSize })
  const frame = transfer.cycle[1]!

  it.each(['half', 'bg'] as const)('decodes a pixel-perfect %s-mode screen', (mode) => {
    const version = mode === 'half' ? 10 : 6
    const bytes = mode === 'half' ? frame : randomBytes(byteCapacity(6, 'M'), 9)
    expect(decode(screenImage(bytes, version, 'M', mode))).toEqual(bytes)
  })

  it('shows the same bytes under a different mask on every cycle', () => {
    const bits = (rotation: number) => {
      const matrix = encodeSymbol(frame, 10, 'M', rotation)
      let s = ''
      for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) s += matrix.get(x, y) ? 1 : 0
      return s
    }
    const patterns = new Set<string>()
    for (let rotation = 0; rotation < 8; rotation++) {
      const matrix = encodeSymbol(frame, 10, 'M', rotation)
      patterns.add(bits(rotation))
      const img = new VTerm({ cols: 70, rows: 36 })
      img.write(composeScreen(renderSymbol(matrix, 2, 'half'), geometry(10, { ecc: 'M', quiet: 2, mode: 'half' }).footprint, { cols: 70, rows: 36 }, ''))
      expect(decode(img.rasterize())).toEqual(frame)
    }
    expect(patterns.size).toBe(8)
    expect(bits(8)).toBe(bits(0)) // wraps after all eight
  })

  it('survives fonts whose block glyphs leave a gap between lines', () => {
    for (const lineGap of [2, 4]) expect(decode(screenImage(frame, 10, 'M', 'half', { lineGap }))).toEqual(frame)
  })

  it.each([1, 2, 3, 4])('decodes a tilted, defocused, noisy (σ=16), low-contrast camera view (seed %i)', (seed) => {
    const shot = shoot(screenImage(frame, 10, 'M', 'half'), { blur: 2, noise: 16, levels: [45, 210], seed })
    expect(decode(shot)).toEqual(frame)
  })

  it('returns nothing (not garbage) for a torn half-redrawn screen', () => {
    const a = screenImage(transfer.cycle[1]!, 10, 'M', 'half')
    const b = screenImage(transfer.cycle[2]!, 10, 'M', 'half')
    const torn = { ...a, data: a.data.slice() }
    torn.data.set(b.data.subarray(0, (a.height >> 1) * a.width))
    const result = decode(torn)
    // jsQR's Reed–Solomon usually refuses; if it ever "succeeds", the frame CRC must still reject it.
    if (result) expect([transfer.cycle[1], transfer.cycle[2]]).toContainEqual(result)
  })
})
