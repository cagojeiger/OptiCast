// Synthetic phone camera: projects a screen image into a camera frame with
// perspective, exposure compression, blur and sensor noise.

import type { GrayImage } from './vterm.ts'

export type Point = [number, number]

export interface CameraOptions {
  width: number
  height: number
  /** Where the screen's tl, tr, br, bl corners land in the camera frame. */
  corners: [Point, Point, Point, Point]
  /** Output gray range for screen black/white (glare lifts black, exposure dims white). */
  levels?: [number, number]
  /** Box-blur radius in pixels (defocus / motion), rounded to whole pixels. */
  blur?: number
  /** Gaussian noise sigma in gray levels. */
  noise?: number
  /** Gray level outside the screen. */
  surround?: number
  seed?: number
}

/** Corners for a screen of aspect `aspect` filling `fill` of the frame, tilted by `skew` (0–0.2). */
export function framing(width: number, height: number, aspect: number, fill = 0.8, skew = 0.06): [Point, Point, Point, Point] {
  let w = width * fill
  let h = w / aspect
  if (h > height * fill) {
    h = height * fill
    w = h * aspect
  }
  const x0 = (width - w) / 2
  const y0 = (height - h) / 2
  const dx = w * skew
  const dy = h * skew
  return [
    [x0 + dx, y0],
    [x0 + w - dx * 0.4, y0 + dy],
    [x0 + w, y0 + h - dy * 0.5],
    [x0 - dx * 0.3, y0 + h],
  ]
}

export function cameraView(src: GrayImage, opts: CameraOptions): GrayImage {
  const { width, height } = opts
  const [lo, hi] = opts.levels ?? [0, 255]
  const surround = opts.surround ?? 30
  // Map camera pixels back onto the screen (inverse warp) so every output pixel is sampled once.
  const H = homography(opts.corners, [
    [0, 0],
    [src.width, 0],
    [src.width, src.height],
    [0, src.height],
  ])
  let out: Float32Array = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = H[6]! * x + H[7]! * y + 1
      const u = (H[0]! * x + H[1]! * y + H[2]!) / w
      const v = (H[3]! * x + H[4]! * y + H[5]!) / w
      out[y * width + x] = u >= 0 && v >= 0 && u < src.width - 1 && v < src.height - 1 ? lo + (bilinear(src, u, v) / 255) * (hi - lo) : surround
    }
  }
  const radius = Math.round(opts.blur ?? 0) // a fractional radius would index between samples (NaN)
  if (radius > 0) out = boxBlur(boxBlur(out, width, height, radius, true), width, height, radius, false)
  const random = gaussian(opts.seed ?? 1)
  const data = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(out[i]! + (opts.noise ? random() * opts.noise : 0))))
  return { width, height, data }
}

/** A capture made while the terminal repaints: rows above `boundary` from the newer frame (diodecam_sim::tear). */
export function tear(newer: GrayImage, older: GrayImage, boundary: number): GrayImage {
  if (newer.width !== older.width || newer.height !== older.height) throw new Error('tear: frames differ in size')
  const data = older.data.slice()
  data.set(newer.data.subarray(0, Math.min(boundary, newer.height) * newer.width))
  return { width: newer.width, height: newer.height, data }
}

/** Gray → RGBA, the layout of canvas ImageData. */
export function toRgba(img: GrayImage): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(img.width * img.height * 4)
  for (let i = 0; i < img.data.length; i++) {
    const g = img.data[i]!
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

function bilinear(img: GrayImage, u: number, v: number): number {
  const x = Math.floor(u)
  const y = Math.floor(v)
  const fx = u - x
  const fy = v - y
  const i = y * img.width + x
  const d = img.data
  return (d[i]! * (1 - fx) + d[i + 1]! * fx) * (1 - fy) + (d[i + img.width]! * (1 - fx) + d[i + img.width + 1]! * fx) * fy
}

function boxBlur(src: Float32Array, width: number, height: number, r: number, horizontal: boolean): Float32Array {
  const out = new Float32Array(src.length)
  const [outer, inner] = horizontal ? [height, width] : [width, height]
  for (let a = 0; a < outer; a++) {
    for (let b = 0; b < inner; b++) {
      let sum = 0
      let n = 0
      for (let k = Math.max(0, b - r); k <= Math.min(inner - 1, b + r); k++) {
        sum += src[horizontal ? a * width + k : k * width + a]!
        n++
      }
      out[horizontal ? a * width + b : b * width + a] = sum / n
    }
  }
  return out
}

/** Solves the 8-parameter projective map taking `from` quad onto `to` quad. */
function homography(from: Point[], to: Point[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!
    const [u, v] = to[i]!
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u])
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v])
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r
    ;[A[col], A[pivot]] = [A[pivot]!, A[col]!]
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = A[r]![col]! / A[col]![col]!
      for (let c = col; c < 9; c++) A[r]![c]! -= f * A[col]![c]!
    }
  }
  return A.map((row, i) => row[8]! / row[i]!)
}

function gaussian(seed: number): () => number {
  let s = seed >>> 0 || 1
  const uniform = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) + 0.5) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}
