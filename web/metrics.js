// @ts-check
// Rolling numbers for the receiver screen (docs/protocol.md). Pure functions of
// timestamped samples, so they are unit-tested without a browser.

/**
 * @typedef {object} FrameSample
 * @property {number} t ms (performance.now) when the camera frame was captured.
 * @property {boolean} grid A grid was found in it.
 * @property {number} tilesOk
 * @property {number} tiles
 */

/**
 * @typedef {object} ProgressSample
 * @property {number} t
 * @property {number} have Distinct symbols collected so far.
 */

/** @typedef {'faster' | 'slower' | 'aim'} Hint */

/**
 * Keeps samples no older than `windowMs` before the newest one.
 * @template {{ t: number }} T
 * @param {T[]} samples
 * @param {number} windowMs
 */
export function trim(samples, windowMs) {
  const last = samples[samples.length - 1]
  if (!last) return samples
  const i = samples.findIndex((s) => s.t >= last.t - windowMs)
  return i > 0 ? samples.slice(i) : samples
}

/**
 * Tiles passed ÷ tiles tried over the frames given (null: no grid seen).
 * @param {FrameSample[]} frames
 */
export function recognition(frames) {
  let ok = 0
  let total = 0
  for (const f of frames) {
    ok += f.tilesOk
    total += f.tiles
  }
  return total ? ok / total : null
}

/**
 * New symbols per second across the samples (needs at least half a second).
 * @param {ProgressSample[]} progress
 */
export function symbolRate(progress) {
  const first = progress[0]
  const last = progress[progress.length - 1]
  if (!first || !last || last.t - first.t < 500) return null
  return ((last.have - first.have) * 1000) / (last.t - first.t)
}

/**
 * Seconds until `need` symbols at the recent rate.
 * @param {number} have
 * @param {number | null} need
 * @param {number | null} rate
 */
export function eta(have, need, rate) {
  if (need === null || rate === null) return null
  const left = Math.max(0, need - have)
  if (left === 0) return 0
  return rate > 0 ? left / rate : null
}

/**
 * The advice line: recognition ≥ 90 % → the sender may go faster; < 70 % → slower; no grid → aim.
 * @param {FrameSample[]} frames
 * @returns {Hint | null}
 */
export function hint(frames) {
  if (!frames.length) return null
  const r = recognition(frames)
  if (r === null || !frames.some((f) => f.grid)) return 'aim'
  if (r >= 0.9) return 'faster'
  if (r < 0.7) return 'slower'
  return null
}

/** @type {Record<Hint, string>} */
export const HINT_TEXT = {
  faster: '송신 fps를 올려도 됩니다 (+)',
  slower: '송신 fps를 낮추세요(-)',
  aim: '화면 전체가 들어오게 비추세요',
}

/**
 * Frames per second from callback timestamps (ms).
 * @param {number[]} times
 */
export function fps(times) {
  const first = times[0]
  const last = times[times.length - 1]
  if (first === undefined || last === undefined || last - first < 300) return null
  return ((times.length - 1) * 1000) / (last - first)
}

/**
 * `?max=` in MiB: an integer clamped to [1, 512] (a phone has to hold the file,
 * the RaptorQ payload and the decoder); 64 when absent or not a number.
 * @param {string | null} param
 */
export function limitMib(param) {
  const n = Math.floor(Number(param))
  if (param === null || param.trim() === '' || !Number.isFinite(n)) return 64
  return Math.min(512, Math.max(1, n))
}

/**
 * `?scan=` width: an integer clamped to [64, video width]; min(video width, 1920) when absent or not a number.
 * @param {string | null} param
 * @param {number} videoWidth
 */
export function scanWidth(param, videoWidth) {
  const n = Math.floor(Number(param))
  if (param === null || param.trim() === '' || !Number.isFinite(n)) return Math.min(videoWidth, 1920)
  return Math.min(videoWidth, Math.max(64, n))
}

/**
 * "파일이 너무 큽니다: N MiB > 한도 M MiB".
 * @param {number} size
 * @param {number} limit
 */
export function tooLargeText(size, limit) {
  /** @param {number} n */
  const mib = (n) => (n / 2 ** 20).toLocaleString('en-US', { maximumFractionDigits: n < 10 * 2 ** 20 ? 1 : 0 })
  return `파일이 너무 큽니다: ${mib(size)} MiB > 한도 ${mib(limit)} MiB (?max= 로 바꿀 수 있습니다)`
}

/**
 * SI units like the sender's status bar (1 KB = 1000 B).
 * @param {number} n
 */
export function formatBytes(n) {
  if (n < 1000) return `${n} B`
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)} KB`
  if (n < 1e9) return `${(n / 1e6).toFixed(2)} MB`
  return `${(n / 1e9).toFixed(2)} GB`
}

/** @param {number} s */
export function formatSeconds(s) {
  if (s < 1) return '1초 미만'
  if (s < 60) return `${Math.ceil(s)}초`
  const m = Math.floor(s / 60)
  const r = Math.ceil(s % 60)
  return m < 60 ? `${m}분 ${r}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}

/** @param {number} n */
export function thousands(n) {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Defensive copy of the wasm-side rule: path separators, NUL, control and
 * bidi-override characters become `_`; empty, `.`, `..` become `file`.
 * @param {string} name
 */
export function safeName(name) {
  const clean = name.replace(/[/\\\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '_')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}
