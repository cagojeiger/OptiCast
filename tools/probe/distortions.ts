// Sweeps synthetic camera conditions and reports how often the receiver's
// decoder (with and without its denoise pass) reads the symbol.
//
// usage: node tools/probe/distortions.ts

import jsQR from 'jsqr'
import { prepareTransfer } from '../../src/core/index.ts'
import { denoise } from '../../src/receiver/preprocess.ts'
import { geometry } from '../../src/sender/plan.ts'
import { encodeSymbol } from '../../src/sender/qr.ts'
import { composeScreen, renderSymbol } from '../../src/sender/terminal.ts'
import { randomBytes } from '../../test/helpers.ts'
import { cameraView, downscale2x, framing, toRgba } from '../sim/camera.ts'
import { VTerm, type GrayImage } from '../sim/vterm.ts'

const SENSOR = { width: 1920, height: 1080 }
const SEEDS = [1, 2, 3, 4]

function reads(img: GrayImage, smooth: boolean): boolean {
  const rgba = toRgba(img)
  if (smooth) denoise(rgba, img.width, img.height)
  return jsQR(rgba, img.width, img.height, { inversionAttempts: 'dontInvert' }) !== null
}

console.log(`sensor ${SENSOR.width}x${SENSOR.height} -> 960 scan, defocus blur 2, levels 45..210; hits out of ${SEEDS.length}`)
console.log('version  fill  ' + [0, 4, 8, 12, 16, 24].map((n) => `σ${n} raw/dn`.padEnd(12)).join(''))
for (const version of [6, 10, 15]) {
  const geo = geometry(version, { ecc: 'M', quiet: 2, mode: 'half' })
  const transfer = await prepareTransfer(randomBytes(4000), { filename: 's.bin', blockSize: geo.blockSize })
  const term = { cols: geo.footprint.cols + 10, rows: geo.footprint.rows + 3 }
  const vt = new VTerm(term)
  vt.write(composeScreen(renderSymbol(encodeSymbol(transfer.cycle[1]!, version, 'M'), 2, 'half'), geo.footprint, term, 'status'))
  const screen = vt.rasterize()
  for (const fill of [0.8, 0.45]) {
    const corners = framing(SENSOR.width, SENSOR.height, screen.width / screen.height, fill, 0.03)
    let line = `v${version}`.padEnd(9) + `${fill}`.padEnd(6)
    for (const noise of [0, 4, 8, 12, 16, 24]) {
      let raw = 0
      let dn = 0
      for (const seed of SEEDS) {
        const img = downscale2x(cameraView(screen, { ...SENSOR, corners, blur: 2, noise, levels: [45, 210], seed }))
        if (reads(img, false)) raw++
        if (reads(img, true)) dn++
      }
      line += `${raw}/${dn}`.padEnd(12)
    }
    console.log(line)
  }
}
