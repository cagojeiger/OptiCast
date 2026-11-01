// Prototype of the v2 `ssh` profile: a full-screen module grid drawn with only
// ' ', '▀' and reverse video, so it needs no color support and ignores the theme.
//
// A module is the terminal's own foreground (1) or background (0) color. The
// bottom module of a cell is always the cell background, so a font's line gap
// takes the bottom module's color (the same "background first" rule as v1):
//
//   top bottom   write
//    0    0      ' '            normal
//    1    1      ' '            reverse
//    1    0      '▀'            normal   (glyph = fg on top, cell bg below)
//    0    1      '▀'            reverse  (glyph = bg on top, cell fg below)

export type Modules = (x: number, y: number) => boolean

/** ANSI for a w × h module grid (h even), one terminal row per two module rows. */
export function renderSsh(bits: Modules, w: number, h: number): string {
  let out = '\x1b[?2026h'
  for (let row = 0; row < h / 2; row++) {
    out += `\x1b[${row + 1};1H`
    let reverse: boolean | null = null
    for (let x = 0; x < w; x++) {
      const top = bits(x, row * 2)
      const bottom = bits(x, row * 2 + 1)
      if (bottom !== reverse) {
        out += bottom ? '\x1b[7m' : '\x1b[m' // the cell background must carry the bottom module
        reverse = bottom
      }
      out += top === bottom ? ' ' : '▀'
    }
    out += '\x1b[m'
  }
  return out + '\x1b[?2026l'
}

/**
 * A mock v2 frame: 1-module quiet border, finder marks in three corners and a
 * smaller one in the fourth (so the receiver knows which way is up and which
 * color is "1"), timing lines between them, random bits everywhere else (where
 * the tiles go).
 */
export function mockFrame(w: number, h: number, seed: number): Modules {
  const grid = new Uint8Array(w * h)
  let s = seed >>> 0 || 1
  for (let i = 0; i < grid.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    grid[i] = s & 1
  }
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y * w + x] = v
  }
  const square = (x0: number, y0: number, size: number) => {
    for (let y = -1; y <= size; y++) {
      for (let x = -1; x <= size; x++) {
        const ring = Math.min(x, y, size - 1 - x, size - 1 - y)
        set(x0 + x, y0 + y, ring < 0 ? 0 : ring % 2 === 0 ? 1 : 0) // ring -1 is the separator
      }
    }
  }
  const q = 1
  for (let x = 0; x < w; x++) (set(x, 0, 0), set(x, h - 1, 0))
  for (let y = 0; y < h; y++) (set(0, y, 0), set(w - 1, y, 0))
  square(q, q, 7)
  square(w - q - 7, q, 7)
  square(q, h - q - 7, 7)
  square(w - q - 5, h - q - 5, 5)
  for (let x = q + 8; x < w - q - 8; x++) (set(x, q + 3, x % 2), set(x, h - q - 3, x % 2))
  for (let y = q + 8; y < h - q - 8; y++) (set(q + 3, y, y % 2), set(w - q - 3, y, y % 2))
  return (x, y) => grid[y * w + x] === 1
}

/** The same grid as plain text, for documents: █ both, ▀ top, ▄ bottom, ' ' neither. */
export function previewText(bits: Modules, w: number, h: number): string {
  const lines: string[] = []
  for (let row = 0; row < h / 2; row++) {
    let line = ''
    for (let x = 0; x < w; x++) {
      const top = bits(x, row * 2)
      const bottom = bits(x, row * 2 + 1)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
