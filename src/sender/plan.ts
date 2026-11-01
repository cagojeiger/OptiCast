// Picks the optical frame geometry for a terminal and reports what a transfer will cost.

import { ENVELOPE_FIXED_SIZE, FRAME_OVERHEAD } from '../core/index.ts'
import { byteCapacity, MAX_VERSION, MIN_VERSION, moduleCount, type Ecc } from './qr.ts'
import { footprint, type RenderMode, type Size } from './terminal.ts'

/** Smallest DATA payload we accept: the envelope plus a few bytes of filename must fit in META. */
export const MIN_BLOCK_SIZE = ENVELOPE_FIXED_SIZE + 2 + 8

export interface GeometryOptions {
  ecc: Ecc
  quiet: number
  mode: RenderMode
}

export interface Geometry extends GeometryOptions {
  version: number
  modules: number
  capacity: number
  blockSize: number
  footprint: Size
}

export function geometry(version: number, opts: GeometryOptions): Geometry {
  const modules = moduleCount(version)
  const capacity = byteCapacity(version, opts.ecc)
  return {
    ...opts,
    version,
    modules,
    capacity,
    blockSize: capacity - FRAME_OVERHEAD,
    footprint: footprint(modules, opts.quiet, opts.mode),
  }
}

/** Largest QR version ≤ maxVersion whose symbol fits the terminal above one status row. */
export function fitVersion(term: Size, maxVersion: number, opts: GeometryOptions): number | null {
  for (let v = Math.min(maxVersion, MAX_VERSION); v >= MIN_VERSION; v--) {
    const fp = footprint(moduleCount(v), opts.quiet, opts.mode)
    if (fp.cols <= term.cols && fp.rows <= term.rows - 1) return v
  }
  return null
}

/** Smallest version whose frames can carry the envelope at this ECC level. */
export function minUsableVersion(ecc: Ecc): number {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (byteCapacity(v, ecc) - FRAME_OVERHEAD >= MIN_BLOCK_SIZE) return v
  }
  return MAX_VERSION
}
