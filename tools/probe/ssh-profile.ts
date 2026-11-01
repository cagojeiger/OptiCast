// SSH baseline profile: two modules per cell with no color codes at all.
//
// Encoding: see tools/sim/grid.ts.
//
// usage: node tools/probe/ssh-profile.ts

import { randomBytes } from '../../test/helpers.ts'
import { renderSsh as render } from '../sim/grid.ts'
import { VTerm } from '../sim/vterm.ts'

const themes = { dark: { defaultFg: 220, defaultBg: 24 }, light: { defaultFg: 30, defaultBg: 235 } }
for (const [cols, rows] of [[80, 24], [200, 55]] as const) {
  const w = cols - 1 // last column left empty
  const h = (rows - 1) * 2 // last row is the status line
  const data = randomBytes(Math.ceil((w * h) / 8), cols)
  const bit = (x: number, y: number) => ((data[(y * w + x) >> 3]! >> ((y * w + x) & 7)) & 1) === 1
  const ansi = render(bit, w, h)
  const results: string[] = []
  for (const [name, theme] of Object.entries(themes)) {
    for (const lineGap of [0, 3]) {
      const vt = new VTerm({ cols, rows, ...theme })
      vt.write(ansi)
      const img = vt.rasterize({ lineGap })
      const fgLevel = theme.defaultFg
      let errors = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // module centre: cells are 8x16 px, each module is the top or bottom 8 px
          const px = img.data[(y * 8 + 4) * img.width + x * 8 + 4]!
          const isFg = Math.abs(px - fgLevel) < Math.abs(px - (theme.defaultBg))
          if (isFg !== bit(x, y)) errors++
        }
      }
      results.push(`${name}/gap${lineGap}: ${errors} errors`)
    }
  }
  const bytes = Buffer.byteLength(ansi)
  console.log(`${cols}x${rows}: ${w}x${h} modules, ${(bytes / 1024).toFixed(1)} KB/frame (${(bytes / (w * h)).toFixed(2)} B/module) | ${results.join(', ')}`)
}
