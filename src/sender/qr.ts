// Optical layer v0: one frame = one QR Code symbol in byte mode.
// QR supplies finder patterns, orientation, quiet zone and in-symbol Reed–Solomon ECC.

import QRCode from 'qrcode'

export type Ecc = 'L' | 'M' | 'Q' | 'H'
export const MIN_VERSION = 1
export const MAX_VERSION = 40

/** Square module matrix; `true` = dark module. */
export interface ModuleMatrix {
  size: number
  get(x: number, y: number): boolean
}

export function moduleCount(version: number): number {
  return 17 + 4 * version
}

/**
 * `rotation` moves the mask that many steps away from the encoder's choice. The bytes
 * are identical, but the module pattern is not: a symbol that one fixed camera pose
 * cannot read (aliasing against the sensor grid) looks different on the next cycle.
 */
export function encodeSymbol(bytes: Uint8Array, version: number, ecc: Ecc, rotation = 0): ModuleMatrix {
  const segments = [{ data: new Uint8ClampedArray(bytes), mode: 'byte' as const }]
  let symbol = QRCode.create(segments, { version, errorCorrectionLevel: ecc })
  const shift = ((rotation % 8) + 8) % 8
  if (shift !== 0) {
    const maskPattern = (((symbol.maskPattern ?? 0) + shift) % 8) as QRCode.QRCodeMaskPattern
    symbol = QRCode.create(segments, { version, errorCorrectionLevel: ecc, maskPattern })
  }
  const { modules } = symbol
  return { size: modules.size, get: (x, y) => modules.get(y, x) === 1 }
}

const capacityCache = new Map<string, number>()

/** Largest byte-mode payload that fits the given version/ECC, found by asking the encoder itself. */
export function byteCapacity(version: number, ecc: Ecc): number {
  const key = `${version}${ecc}`
  const cached = capacityCache.get(key)
  if (cached !== undefined) return cached
  const fits = (n: number) => {
    try {
      QRCode.create([{ data: new Uint8ClampedArray(n), mode: 'byte' }], { version, errorCorrectionLevel: ecc })
      return true
    } catch {
      return false
    }
  }
  let lo = 0
  let hi = 3000 // v40-L holds 2953 bytes
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  capacityCache.set(key, lo)
  return lo
}
