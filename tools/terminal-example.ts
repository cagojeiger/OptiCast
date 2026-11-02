// The "this is what the terminal looks like" picture on the setup page
// (web/example-terminal.svg): one real sender frame for a small sample file,
// replayed through the virtual terminal, drawn cell by cell, with the two status
// lines the sender prints. Regenerate when the frame format or status line changes.
//
// usage: node tools/terminal-example.ts   (needs cargo; writes web/example-terminal.svg)

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cargo } from './cargo.ts'
import { VTerm } from './sim/vterm.ts'
import { randomBytes } from '../test/helpers.ts'

const COLS = 80
const ROWS = 24
const CELL_W = 8
const CELL_H = 16

const dir = mkdtempSync(join(tmpdir(), 'diodecam-example-'))
const input = join(dir, 'report.pdf')
writeFileSync(input, randomBytes(24_000, 11))
const out = join(dir, 'frames.jsonl')
cargo(['run', '-q', '-p', 'diodecam-cli', '--', 'frames', input, '--cols', `${COLS}`, '--rows', `${ROWS}`, '--count', '1', '--out', out])
// JSON lines: a header object first, then one object per frame.
const frame = JSON.parse(readFileSync(out, 'utf8').split('\n').filter((l) => l.trim())[1]!) as { ansi: string }

// Replay the real ANSI bytes; then read the terminal back as pixels (one cell = 8×16,
// `▀` lights the top half) and draw each half-cell as a rect.
const term = new VTerm({ cols: COLS, rows: ROWS, defaultFg: 0xd4, defaultBg: 0x1e })
term.write(frame.ansi)
const img = term.rasterize({ cellWidth: CELL_W, cellHeight: CELL_H, lineGap: 0 })
const light = (x: number, y: number) => img.data[y * img.width + x]! > 0x80

// The sender centres a grid that may be narrower than the terminal; crop to the lit columns.
let minCol = COLS
let maxCol = -1
for (let row = 0; row < ROWS; row++)
  for (let col = 0; col < COLS; col++)
    for (let half = 0; half < 2; half++)
      if (light(col * CELL_W + CELL_W / 2, row * CELL_H + half * (CELL_H / 2) + CELL_H / 4)) {
        minCol = Math.min(minCol, col)
        maxCol = Math.max(maxCol, col)
      }
const DRAWN = maxCol - minCol + 1
const H = ROWS * CELL_H
const W = DRAWN * CELL_W
let rects = ''
for (let row = 0; row < ROWS; row++)
  for (let half = 0; half < 2; half++) {
    const y = row * CELL_H + half * (CELL_H / 2) + CELL_H / 4
    let runStart = -1
    for (let col = 0; col <= COLS; col++) {
      const on = col < COLS && light(col * CELL_W + CELL_W / 2, y)
      if (on && runStart < 0) runStart = col
      if (!on && runStart >= 0) {
        rects += `<rect x="${(runStart - minCol) * CELL_W}" y="${row * CELL_H + half * (CELL_H / 2)}" width="${(col - runStart) * CELL_W}" height="${CELL_H / 2}"/>`
        runStart = -1
      }
    }
  }

// The status lines, in the CLI's own format (crates/diodecam-cli/src/status.rs), trimmed to the
// drawn width the way the sender trims to the terminal.
const line1 = ` DiodeCam  report.pdf 24.0 KB  id 3f2a9c1e  ssh ${DRAWN - 1}x${ROWS * 2 - 4}  5 tiles`
const line2 = ' 00:12  source 100% [##########]  +repair 1,240  24 fps  phone needs ~3s  [q] quit'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const status = (text: string, i: number) =>
  `<text x="0" y="${H + i * CELL_H + 12}" font-family="ui-monospace, SF Mono, Menlo, Consolas, monospace" font-size="13" textLength="${Math.min(text.length, DRAWN) * CELL_W}" lengthAdjust="spacingAndGlyphs" fill="#1e1e1e" xml:space="preserve">${esc(text.slice(0, DRAWN))}</text>`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 2 * CELL_H}" role="img" aria-label="The terminal while sending: a grid of half blocks, then two status lines">
<rect width="${W}" height="${H}" fill="#1e1e1e"/>
<g fill="#d4d4d4">${rects}</g>
<rect y="${H}" width="${W}" height="${2 * CELL_H}" fill="#d4d4d4"/>
${status(line1, 0)}
${status(line2, 1)}
</svg>
`
writeFileSync('web/example-terminal.svg', svg)
console.log(`example  web/example-terminal.svg (${(svg.length / 1024).toFixed(1)} KiB, ${DRAWN}×${ROWS} cells)`)
