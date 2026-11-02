// The decoder's floor: tiles read per pixels-per-module and blur, on frames of a
// real sender projected through the synthetic camera (tools/sim). Eight frames per
// cell on a fresh receiver, 1920×1080, a slight tilt, sensor noise σ 6. Prints the
// share of tiles read, the stage the failing frames stopped at, and the module size
// the receiver itself measured (what the ⓘ sheet calls Module; the tilt and the
// 119-module grid make it a little smaller than nominal). Run it before and after
// a change to crates/diodecam-vision.
//
// usage: node tools/floor.ts [cols = 120] [rows = 40]   (builds target/debug/diodecam and web/diodecam.wasm first)

import { readFileSync } from 'node:fs'
import { moduleSize } from '../web/metrics.js'
import { WasmReceiver } from '../web/wasm.js'
import { cameraView, framing, toRgba } from './sim/camera.ts'
import { randomBytes, senderFrames } from './sim/sender.ts'
import { VTerm } from './sim/vterm.ts'

const COLS = Number(process.argv[2] ?? 120)
const ROWS = Number(process.argv[3] ?? 40)
const FRAMES = 8
const PX = [2.5, 3, 3.5, 4, 4.5, 5, 6, 8]
const BLUR = [0, 1, 2, 3]
const camera = { width: 1920, height: 1080 }

// Measure the code as it is now, never a stale sender (senderFrames runs cargo) or decoder.
const { header, frames } = senderFrames({ bytes: randomBytes(200_000, 5), name: 'data.bin', cols: COLS, rows: ROWS, count: FRAMES })
await import('./wasm-build.ts')
const wasm = readFileSync('web/diodecam.wasm')

const vt = new VTerm({ cols: COLS, rows: ROWS })
const screens = frames.map((ansi) => {
  vt.write(ansi)
  return vt.rasterize({ lineGap: 2 })
})

console.log(`${COLS}×${ROWS} terminal → grid ${header.width}×${header.height}, ${header.tiles} tiles per frame, camera ${camera.width}×${camera.height}, ${FRAMES} frames per cell`)
console.log('nominal px' + BLUR.map((b) => `blur ${b} px`.padStart(18)).join(''))
for (const px of PX) {
  let row = px.toFixed(1).padStart(7) + '   '
  for (const blur of BLUR) {
    const rx = await WasmReceiver.create(wasm)
    let ok = 0
    const measured: number[] = []
    const stages: Record<string, number> = {}
    for (const [i, screen] of screens.entries()) {
      // The screen is 8 px per cell, one module per cell across. framing() fits the screen to the
      // frame's width or, for a tall terminal, its height: `span` is the screen's width at fill 1.
      const span = Math.min(camera.width, camera.height * (screen.width / screen.height))
      const fill = Math.min(0.95, (px * screen.width) / (8 * span))
      const corners = framing(camera.width, camera.height, screen.width / screen.height, fill, 0.03)
      const shot = cameraView(screen, { ...camera, corners, blur, noise: 6, levels: [30, 220], seed: i + 1 })
      const r = rx.process(toRgba(shot), shot.width, shot.height)
      const s = rx.stats()
      if (r < header.tiles) {
        const stage = s.stage ?? 'none'
        stages[stage] = (stages[stage] ?? 0) + 1
      }
      if (r >= 0) {
        ok += r
        const m = moduleSize(s.corners, s.grid)
        if (m !== null) measured.push(m)
      }
    }
    const pct = Math.round((ok / (FRAMES * header.tiles)) * 100)
    const stuck = Object.entries(stages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    const m = measured.length ? (measured.reduce((a, b) => a + b, 0) / measured.length).toFixed(1) : '—'
    row += `${pct}%`.padStart(5) + ` ${pct === 100 ? '' : stuck}`.padEnd(9) + m.padStart(4)
  }
  console.log(row)
}
