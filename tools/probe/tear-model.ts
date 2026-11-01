// Timing model for "the camera caught the screen mid-redraw", and what it costs.
//
// Screen: frame n is written at n*T. Row y (0 = top, 1 = bottom) of it becomes
// visible at the first vsync after n*T + y*P (P = time for the terminal to parse
// and paint one frame; P = 0 is synchronized output, the whole frame swaps at one
// vsync), plus y*S while the panel scans out, and needs `tau` ms to settle.
// Camera: capture k starts at phi + k*Tc; sensor row r is exposed during
// [t + r*R, t + r*R + E] (rolling shutter).
// A region is clean in a capture if every row in it is exposed entirely inside
// one frame's stable interval. A frame (or tile row) counts once it was clean in
// at least one capture.
//
// Second part: repetition (send the same cycle again) vs a systematic fountain
// code (first cycle = source blocks, then endless fresh repair symbols).
//
// usage: node tools/probe/tear-model.ts

const VSYNC = 1000 / 60

interface Timing {
  fps: number
  Tc: number // camera frame interval, ms
  R: number // rolling-shutter readout, ms
  E: number // exposure, ms
  tau: number // panel settle time, ms
  P: number // terminal paint time per frame, ms
  K: number // independent tile rows per frame (1 = one symbol per frame)
}

function captured(t: Timing, frames = 300, trials = 8): number {
  const T = 1000 / t.fps
  const appear = (n: number, y: number) => Math.ceil((n * T + y * t.P) / VSYNC) * VSYNC + y * VSYNC
  let ok = 0
  let total = 0
  for (let trial = 0; trial < trials; trial++) {
    const got = new Set<number>()
    for (let start = Math.random() * t.Tc; start < frames * T; start += t.Tc) {
      for (let j = 0; j < t.K; j++) {
        let frame: number | null = null
        let clean = true
        for (let s = 0; s <= 8 && clean; s++) {
          const y = (j + s / 8) / t.K
          const a = start + y * t.R
          let n = Math.floor(a / T) + 1
          while (n > 0 && appear(n, y) + t.tau > a) n--
          if (appear(n, y) + t.tau > a || a + t.E > appear(n + 1, y)) clean = false
          else if (frame === null) frame = n
          else if (frame !== n) clean = false
        }
        if (clean && frame !== null && frame >= 2 && frame < frames - 2) got.add(frame * t.K + j)
      }
    }
    ok += got.size
    total += (frames - 4) * t.K
  }
  return ok / total
}

const phone = { Tc: 1000 / 30, R: 20, E: 8, tau: 5 }
console.log('camera 30 fps, readout 20 ms, exposure 8 ms: share of frames (or tile rows) captured clean')
for (const P of [0, 15, 40, 80]) {
  for (const K of [1, 8]) {
    const cells = [5, 10, 15, 20].map((fps) => `${String(fps).padStart(2)}fps ${String(Math.round(captured({ fps, ...phone, P, K }) * 100)).padStart(3)}%`)
    let best = { fps: 0, rate: 0 }
    for (let fps = 3; fps <= 25; fps++) {
      const rate = fps * captured({ fps, ...phone, P, K }, 200, 3)
      if (rate > best.rate) best = { fps, rate }
    }
    console.log(`paint ${String(P).padStart(2)} ms  ${K === 1 ? 'whole frame' : `${K} tile rows`}  ${cells.join('  ')}  | best ${best.fps} fps -> ${best.rate.toFixed(1)} useful/s`)
  }
}

let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
function repetition(n: number, loss: number): number {
  const have = new Uint8Array(n)
  let left = n
  let sent = 0
  while (left) {
    const i = sent++ % n
    if (rnd() >= loss && !have[i]) {
      have[i] = 1
      left--
    }
  }
  return sent
}
/** RaptorQ-like: decodable once n + 2 distinct symbols have arrived. */
function fountain(n: number, loss: number): number {
  let got = 0
  let sent = 0
  while (got < n + 2) {
    sent++
    if (rnd() >= loss) got++
  }
  return sent
}
const median = (f: () => number) => Array.from({ length: 41 }, f).sort((a, b) => a - b)[20]!

console.log('\ncycles until complete (median of 41), i.i.d. frame loss')
for (const n of [100, 5378]) {
  for (const loss of [0.05, 0.1, 0.2]) {
    const r = median(() => repetition(n, loss)) / n
    const f = median(() => fountain(n, loss)) / n
    console.log(`${String(n).padStart(4)} blocks, loss ${String(loss * 100).padStart(2)}%: repetition ${r.toFixed(2)}, fountain ${f.toFixed(2)}  (x${(r / f).toFixed(1)})`)
  }
}
