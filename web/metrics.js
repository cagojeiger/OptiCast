// @ts-check
// Rolling numbers for the receiver screen (docs/web.md). Pure functions of
// timestamped samples, so they are unit-tested without a browser.

/** @typedef {'finders' | 'timing' | 'format' | 'geometry' | 'done'} Stage How far the vision got on a frame. */

/**
 * @typedef {object} FrameSample
 * @property {number} t ms (performance.now) when the camera frame was captured.
 * @property {boolean} grid A grid was found in it.
 * @property {number} tilesOk
 * @property {number} tiles
 * @property {Stage | null} [stage]
 * @property {number | null} [module] Pixels per module in the decoder's image (see moduleSize).
 */

/**
 * @typedef {object} ProgressSample
 * @property {number} t
 * @property {number} have Distinct symbols collected so far.
 */

/** @typedef {'faster' | 'slower' | 'aim' | 'focus' | 'straight' | 'closer' | 'rotate'} Hint */

/**
 * Below this many pixels per module tiles start to fail once the image is a
 * little soft (simulated: 100 % from 4.3 px sharp and 4.7 px with a 3 px blur).
 */
export const MIN_MODULE_PX = 4.5

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
 * Pixels per module of a detected grid: the shorter of the mean pitch across
 * and down (corners tl, tr, br, bl as x, y pairs, in the decoder's image).
 * @param {(number | null)[] | null | undefined} corners
 * @param {{ w: number, h: number } | null | undefined} grid
 */
export function moduleSize(corners, grid) {
  if (!corners || !grid || corners.length < 8) return null
  const c = corners.map((v) => v ?? NaN)
  /** @param {number} a @param {number} b */
  const d = (a, b) => Math.hypot((c[2 * b] ?? NaN) - (c[2 * a] ?? NaN), (c[2 * b + 1] ?? NaN) - (c[2 * a + 1] ?? NaN))
  const size = Math.min((d(0, 1) + d(3, 2)) / 2 / grid.w, (d(0, 3) + d(1, 2)) / 2 / grid.h)
  return Number.isFinite(size) ? size : null
}

/**
 * The stage most frames without a grid stopped at, and the share of all frames it stopped.
 * @param {FrameSample[]} frames
 * @returns {{ stage: Exclude<Stage, 'done'>, share: number } | null}
 */
export function failure(frames) {
  /** @type {Partial<Record<Stage, number>>} */
  const counts = {}
  for (const f of frames) if (!f.grid && f.stage && f.stage !== 'done') counts[f.stage] = (counts[f.stage] ?? 0) + 1
  /** @type {Exclude<Stage, 'done'> | null} */
  let top = null
  for (const stage of /** @type {const} */ (['finders', 'timing', 'format', 'geometry'])) {
    if ((counts[stage] ?? 0) > (top ? (counts[top] ?? 0) : 0)) top = stage
  }
  return top ? { stage: top, share: (counts[top] ?? 0) / frames.length } : null
}

/**
 * The `q` quantile (nearest rank) of the finite numbers given; null for none.
 * @param {(number | null | undefined)[]} values
 * @param {number} q 0–1
 */
export function quantile(values, q) {
  const v = /** @type {number[]} */ (values.filter((x) => typeof x === 'number' && Number.isFinite(x))).sort((a, b) => a - b)
  return v.length ? (v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? null) : null
}

/**
 * The advice line (docs/web.md §3). Grid in under half the frames: what stopped
 * them (finders → aim, timing or format → focus, geometry → straight). Otherwise
 * recognition ≥ 90 % → the sender may go faster; < 70 % → modules under
 * MIN_MODULE_PX ask to come closer (or to turn a portrait camera sideways), else slower.
 * @param {FrameSample[]} frames
 * @param {boolean} [portrait] The camera image is taller than wide.
 * @returns {Hint | null}
 */
export function hint(frames, portrait = false) {
  if (!frames.length) return null
  const small = () => (quantile(frames.map((f) => f.module), 0.5) ?? Infinity) < MIN_MODULE_PX
  if (frames.filter((f) => f.grid).length * 2 < frames.length) {
    const stage = failure(frames)?.stage
    if (stage === 'timing' || stage === 'format') return small() ? (portrait ? 'rotate' : 'closer') : 'focus'
    return stage === 'geometry' ? 'straight' : 'aim'
  }
  const r = recognition(frames)
  if (r === null) return 'aim'
  if (r >= 0.9) return 'faster'
  if (r < 0.7) return small() ? (portrait ? 'rotate' : 'closer') : 'slower'
  return null
}

/** @type {Record<Hint, string>} */
export const HINT_TEXT = {
  faster: 'You can raise the sender fps (+)',
  slower: 'Lower the sender fps (-)',
  aim: 'Frame the whole screen, all four corner marks',
  focus: 'The grid is blurred: hold still, at a distance that focuses',
  straight: 'The grid looks bent: face the screen, a little further back',
  closer: 'The grid cells are small: move closer or enlarge the terminal font',
  rotate: 'Hold the phone sideways for a larger grid',
}

/** @type {Record<Exclude<Stage, 'done'>, string>} */
export const STAGE_TEXT = {
  finders: 'finder marks',
  timing: 'timing lines',
  format: 'format info',
  geometry: 'geometry',
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
 * "File too large: N MiB > limit M MiB".
 * @param {number} size
 * @param {number} limit
 */
export function tooLargeText(size, limit) {
  /** @param {number} n */
  const mib = (n) => (n / 2 ** 20).toLocaleString('en-US', { maximumFractionDigits: n < 10 * 2 ** 20 ? 1 : 0 })
  return `File too large: ${mib(size)} MiB > limit ${mib(limit)} MiB (change it with ?max=)`
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
  if (s < 1) return 'under 1 s'
  if (s < 60) return `${Math.ceil(s)} s`
  const m = Math.floor(s / 60)
  const r = Math.ceil(s % 60)
  return m < 60 ? `${m} min ${r} s` : `${Math.floor(m / 60)} h ${m % 60} min`
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
