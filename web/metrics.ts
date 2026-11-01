// Rolling numbers for the receiver screen (receiver-v2 §4). Pure functions of
// timestamped samples, so they are unit-tested without a browser.

export interface FrameSample {
  /** ms (performance.now) when the camera frame was captured. */
  t: number
  /** A grid was found in it. */
  grid: boolean
  tilesOk: number
  tiles: number
}

export interface ProgressSample {
  t: number
  /** Distinct symbols collected so far. */
  have: number
}

/** Keeps samples no older than `windowMs` before the newest one. */
export function trim<T extends { t: number }>(samples: T[], windowMs: number): T[] {
  const last = samples[samples.length - 1]
  if (!last) return samples
  let i = 0
  while (i < samples.length && samples[i]!.t < last.t - windowMs) i++
  return i ? samples.slice(i) : samples
}

/** Tiles passed ÷ tiles tried over the frames given (null: no grid seen). */
export function recognition(frames: FrameSample[]): number | null {
  let ok = 0
  let total = 0
  for (const f of frames) {
    ok += f.tilesOk
    total += f.tiles
  }
  return total ? ok / total : null
}

/** New symbols per second across the samples (needs at least half a second). */
export function symbolRate(progress: ProgressSample[]): number | null {
  const first = progress[0]
  const last = progress[progress.length - 1]
  if (!first || !last || last.t - first.t < 500) return null
  return ((last.have - first.have) * 1000) / (last.t - first.t)
}

/** Seconds until `need` symbols at the recent rate. */
export function eta(have: number, need: number | null, rate: number | null): number | null {
  if (need === null || rate === null) return null
  const left = Math.max(0, need - have)
  if (left === 0) return 0
  return rate > 0 ? left / rate : null
}

export type Hint = 'faster' | 'slower' | 'aim' | null

/** The advice line: recognition ≥ 90 % → the sender may go faster; < 70 % → slower; no grid → aim. */
export function hint(frames: FrameSample[]): Hint {
  if (!frames.length) return null
  if (!frames.some((f) => f.grid)) return 'aim'
  const r = recognition(frames)
  if (r === null) return 'aim'
  if (r >= 0.9) return 'faster'
  if (r < 0.7) return 'slower'
  return null
}

export const HINT_TEXT: Record<Exclude<Hint, null>, string> = {
  faster: '송신 fps를 올려도 됩니다 (+)',
  slower: '송신 fps를 낮추세요(-)',
  aim: '화면 전체가 들어오게 비추세요',
}

/** Frames per second from callback timestamps (ms). */
export function fps(times: number[]): number | null {
  const first = times[0]
  const last = times[times.length - 1]
  if (first === undefined || last === undefined || last - first < 300) return null
  return ((times.length - 1) * 1000) / (last - first)
}

export const DEFAULT_LIMIT_MIB = 64
/** Largest `?max=`: a phone has to hold the file, the RaptorQ payload and the decoder. */
export const MAX_LIMIT_MIB = 512

/** `?max=` in MiB: an integer clamped to [1, 512]; 64 when absent or not a number. */
export function limitMib(param: string | null): number {
  const n = Math.floor(Number(param))
  if (param === null || param.trim() === '' || !Number.isFinite(n)) return DEFAULT_LIMIT_MIB
  return Math.min(MAX_LIMIT_MIB, Math.max(1, n))
}

/** `?scan=` width: an integer clamped to [64, video width]; min(video width, 1920) when absent or not a number. */
export function scanWidth(param: string | null, videoWidth: number): number {
  const fallback = Math.min(videoWidth, 1920)
  const n = Math.floor(Number(param))
  if (param === null || param.trim() === '' || !Number.isFinite(n)) return fallback
  return Math.min(videoWidth, Math.max(64, n))
}

/** "파일이 너무 큽니다: N MiB > 한도 M MiB". */
export function tooLargeText(size: number, limit: number): string {
  const mib = (n: number) => (n / 2 ** 20).toLocaleString('en-US', { maximumFractionDigits: n < 10 * 2 ** 20 ? 1 : 0 })
  return `파일이 너무 큽니다: ${mib(size)} MiB > 한도 ${mib(limit)} MiB (?max= 로 바꿀 수 있습니다)`
}

/** SI units like the sender's status bar (1 KB = 1000 B). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)} KB`
  if (n < 1e9) return `${(n / 1e6).toFixed(2)} MB`
  return `${(n / 1e9).toFixed(2)} GB`
}

export function formatSeconds(s: number): string {
  if (s < 1) return '1초 미만'
  if (s < 60) return `${Math.ceil(s)}초`
  const m = Math.floor(s / 60)
  const r = Math.ceil(s % 60)
  return m < 60 ? `${m}분 ${r}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}

export function thousands(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Defensive copy of the wasm-side rule: path separators, NUL, control and
 * bidi-override characters become `_`; empty, `.`, `..` become `file`.
 */
export function safeName(name: string): string {
  const clean = name.replace(/[/\\\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '_')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}
