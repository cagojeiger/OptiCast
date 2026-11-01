// What a v2 `ssh`-profile frame looks like.
//
// usage: node tools/probe/ssh-demo.ts           # text preview + PNGs in dist/demo/
//        node tools/probe/ssh-demo.ts --show    # draw live frames in this terminal ([q] to quit)

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { cameraView, framing } from '../sim/camera.ts'
import { mockFrame, previewText, renderSsh } from '../sim/grid.ts'
import { writePng } from '../sim/png.ts'
import { VTerm } from '../sim/vterm.ts'

const status = (cols: number, frame: number) =>
  ` OptiCast  data.bin 1.0 MB | ssh profile | 10 fps | frame ${frame} | [q] quit`.slice(0, cols - 1)

if (process.argv.includes('--show')) {
  const out = process.stdout
  const cols = out.columns ?? 80
  const rows = out.rows ?? 24
  const w = cols - 1
  const h = (rows - 1) * 2
  let frame = 0
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J')
  const timer = setInterval(() => {
    frame++
    out.write(renderSsh(mockFrame(w, h, frame), w, h) + `\x1b[${rows};1H\x1b[m${status(cols, frame)}`)
  }, 100)
  const quit = () => {
    clearInterval(timer)
    out.write('\x1b[m\x1b[?7h\x1b[?25h\x1b[?1049l')
    process.exit(0)
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (b) => (b[0] === 0x71 || b[0] === 0x03 || b[0] === 0x1b) && quit())
  process.on('SIGINT', quit)
} else {
  // A small terminal, to read in a document.
  const [pc, pr] = [72, 16]
  console.log(previewText(mockFrame(pc - 1, (pr - 1) * 2, 7), pc - 1, (pr - 1) * 2))
  console.log(status(pc, 1))

  // A real-sized terminal, as images: dark theme, light theme, and through a phone camera.
  const outDir = resolve('dist/demo')
  mkdirSync(outDir, { recursive: true })
  const [cols, rows] = [200, 55]
  const w = cols - 1
  const h = (rows - 1) * 2
  const ansi = renderSsh(mockFrame(w, h, 7), w, h) + `\x1b[${rows};1H\x1b[m${status(cols, 1)}`
  for (const [name, theme] of Object.entries({ dark: { defaultFg: 220, defaultBg: 24 }, light: { defaultFg: 30, defaultBg: 235 } })) {
    const vt = new VTerm({ cols, rows, ...theme })
    vt.write(ansi)
    const screen = vt.rasterize({ lineGap: 2 })
    writePng(resolve(outDir, `ssh-frame-${name}.png`), screen)
    if (name === 'dark') {
      const shot = cameraView(screen, { width: 1920, height: 1080, corners: framing(1920, 1080, screen.width / screen.height, 0.85, 0.06), blur: 1, noise: 8, levels: [40, 215], seed: 3 })
      writePng(resolve(outDir, 'ssh-frame-camera.png'), shot)
    }
  }
  console.log(`\nimages: ${outDir}/ssh-frame-{dark,light,camera}.png`)
}
