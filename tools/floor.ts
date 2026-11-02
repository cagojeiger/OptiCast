// The decoder's floor: tiles read per pixels-per-module and blur, on frames of a
// real sender projected through the synthetic camera (tools/sim). Eight frames per
// cell on a fresh receiver, 1920×1080, a slight tilt, sensor noise σ 6. Prints the
// share of tiles read, the stage most frames stopped at when not all were read,
// and the module size the receiver itself measured (the tilt makes it smaller than
// the nominal value; it is what the ⓘ sheet calls Module). Run it before and after
// a change to crates/diodecam-vision.
//
// usage: node tools/floor.ts [cols = 120] [rows = 40]   (needs target/debug/diodecam and web/diodecam.wasm)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from '../test/helpers.ts'
import { moduleSize } from '../web/metrics.js'
import { WasmReceiver } from '../web/wasm.js'
import { cameraView, framing, toRgba } from './sim/camera.ts'
import { VTerm } from './sim/vterm.ts'

const COLS = Number(process.argv[2] ?? 120)
const ROWS = Number(process.argv[3] ?? 40)
const FRAMES = 8
const PX = [2.5, 3, 3.5, 4, 4.5, 5, 6, 8]
const BLUR = [0, 1, 2, 3]
const camera = { width: 1920, height: 1080 }

const dir = mkdtempSync(join(tmpdir(), 'diodecam-floor-'))
try {
  writeFileSync(join(dir, 'data.bin'), randomBytes(200_000, 5))
  const out = join(dir, 'frames.jsonl')
  const run = spawnSync('target/debug/diodecam', ['frames', join(dir, 'data.bin'), '--cols', `${COLS}`, '--rows', `${ROWS}`, '--count', `${FRAMES}`, '--out', out])
  if (run.status !== 0) throw new Error(run.stderr?.toString() || 'target/debug/diodecam missing: cargo build -p diodecam-cli')
  const [header, ...lines] = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const wasm = readFileSync('web/diodecam.wasm')

  const vt = new VTerm({ cols: COLS, rows: ROWS })
  const screens = lines.map((l) => {
    vt.write(l.ansi)
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
        // The screen is 8 px per cell, one module per cell across: fill so that a module lands on `px` camera pixels.
        const fill = Math.min(0.95, (px * screen.width) / (8 * camera.width))
        const corners = framing(camera.width, camera.height, screen.width / screen.height, fill, 0.03)
        const shot = cameraView(screen, { ...camera, corners, blur, noise: 6, levels: [30, 220], seed: i + 1 })
        const r = rx.process(toRgba(shot), shot.width, shot.height)
        const s = rx.stats()
        const stage = s.stage ?? 'none'
        stages[stage] = (stages[stage] ?? 0) + 1
        if (r >= 0) {
          ok += r
          measured.push(moduleSize(s.corners, s.grid) ?? 0)
        }
      }
      const pct = Math.round((ok / (FRAMES * header.tiles)) * 100)
      const stuck = Object.entries(stages).sort((a, b) => b[1] - a[1])[0]![0]
      const m = measured.length ? (measured.reduce((a, b) => a + b, 0) / measured.length).toFixed(1) : '—'
      row += `${pct}%`.padStart(5) + ` ${pct === 100 ? '' : stuck}`.padEnd(9) + m.padStart(4)
    }
    console.log(row)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
