// The "this is what the terminal looks like" picture on the setup page
// (web/example-terminal.svg): one real sender frame, mid-transfer, for a small sample file,
// replayed through the virtual terminal and drawn cell by cell, status rows included,
// so the picture is what the terminal shows. Regenerate when the frame format or status line changes.
//
// usage: node tools/terminal-example.ts   (needs cargo; writes web/example-terminal.svg)

import { writeFileSync } from 'node:fs'
import { randomBytes, senderFrames } from './sim/sender.ts'
import { VTerm } from './sim/vterm.ts'

const COLS = 80
const ROWS = 24
const CELL_W = 8
const CELL_H = 16

const [ansi] = senderFrames({ bytes: randomBytes(24_000, 11), name: 'report.pdf', cols: COLS, rows: ROWS, skip: 70, count: 1 }).frames

// Replay the real ANSI bytes; then read the terminal back as pixels (one cell = 8×16,
// `▀` lights the top half) and draw each half-cell as a rect.
const term = new VTerm({ cols: COLS, rows: ROWS, defaultFg: 0xd4, defaultBg: 0x1e })
term.write(ansi!)
const img = term.rasterize({ cellWidth: CELL_W, cellHeight: CELL_H, lineGap: 0 })
const light = (x: number, y: number) => img.data[y * img.width + x]! > 0x80

// Crop to the columns the sender drew (the grid is narrower than the terminal).
let minCol = COLS
let maxCol = -1
for (let row = 0; row < ROWS - 2; row++)
  for (let col = 0; col < COLS; col++)
    for (let half = 0; half < 2; half++)
      if (light(col * CELL_W + CELL_W / 2, row * CELL_H + half * (CELL_H / 2) + CELL_H / 4)) {
        minCol = Math.min(minCol, col)
        maxCol = Math.max(maxCol, col)
      }
const DRAWN = maxCol - minCol + 1
const GRID_ROWS = ROWS - 2 // the sender keeps the last two rows for its status lines
const H = ROWS * CELL_H
const W = DRAWN * CELL_W
let rects = ''
for (let row = 0; row < GRID_ROWS; row++)
  for (let half = 0; half < 2; half++) {
    const y = row * CELL_H + half * (CELL_H / 2) + CELL_H / 4
    let runStart = -1
    for (let col = minCol; col <= maxCol + 1; col++) {
      const on = col <= maxCol && light(col * CELL_W + CELL_W / 2, y)
      if (on && runStart < 0) runStart = col
      if (!on && runStart >= 0) {
        rects += `<rect x="${(runStart - minCol) * CELL_W}" y="${row * CELL_H + half * (CELL_H / 2)}" width="${(col - runStart) * CELL_W}" height="${CELL_H / 2}"/>`
        runStart = -1
      }
    }
  }

// The two status rows exactly as the terminal shows them: the sender's own text, read back
// from the cells, same columns as the grid, trimmed to the drawn width.
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const statusRows = [GRID_ROWS, GRID_ROWS + 1].map((row, i) => {
  const text = term.line(row)
  const shown = text.slice(minCol, minCol + DRAWN).replace(/\s+$/, '')
  return `<text x="0" y="${row * CELL_H + 12}" font-family="ui-monospace, SF Mono, Menlo, Consolas, monospace" font-size="13" textLength="${shown.length * CELL_W}" lengthAdjust="spacingAndGlyphs" fill="#d4d4d4" xml:space="preserve">${esc(shown)}</text>`
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="The terminal while sending: a grid of half blocks, then the sender's two status lines">
<rect width="${W}" height="${H}" fill="#1e1e1e"/>
<g fill="#d4d4d4">${rects}</g>
${statusRows.join('\n')}
</svg>
`
writeFileSync('web/example-terminal.svg', svg)
console.log(`example  web/example-terminal.svg (${(svg.length / 1024).toFixed(1)} KiB, ${DRAWN}×${ROWS} cells)`)
