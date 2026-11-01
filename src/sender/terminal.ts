// Terminal renderer: module matrix -> ANSI text.
//
// 'half' packs two module rows into one text row, so a module is one column
// wide and half a row tall (~square on typical 1:2 fonts). Cells whose two
// modules match are a background-colored space; only mixed cells use ▀
// (fg = top, bg = bottom). Terminals paint line spacing with the background
// color, so fonts whose block glyphs don't fill the line can no longer cut
// light stripes through dark areas — those stripes break QR finder detection.
// 'bg' paints two background-colored spaces per module: no glyph dependency
// at all, but half the vertical density. Colors are xterm-256 indices 16
// (#000) and 231 (#fff); themes usually remap only 0–15, so these stay true
// black/white.

import type { ModuleMatrix } from './qr.ts'

export type RenderMode = 'half' | 'bg'

const DARK = 16
const LIGHT = 231
const RESET = '\x1b[0m'
const SYNC_BEGIN = '\x1b[?2026h' // synchronized output: terminals that support it swap the frame atomically
const SYNC_END = '\x1b[?2026l'

export interface Size {
  cols: number
  rows: number
}

/** Terminal cells occupied by a symbol of `modules` modules plus its quiet zone. */
export function footprint(modules: number, quiet: number, mode: RenderMode): Size {
  const span = modules + 2 * quiet
  return mode === 'half' ? { cols: span, rows: Math.ceil(span / 2) } : { cols: span * 2, rows: span }
}

export function renderSymbol(matrix: ModuleMatrix, quiet: number, mode: RenderMode): string[] {
  const span = matrix.size + 2 * quiet
  const dark = (x: number, y: number) => {
    const mx = x - quiet
    const my = y - quiet
    return mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size && matrix.get(mx, my)
  }
  const lines: string[] = []
  if (mode === 'half') {
    for (let y = 0; y < span; y += 2) {
      let line = ''
      let fg = -1
      let bg = -1
      for (let x = 0; x < span; x++) {
        const top = dark(x, y) ? DARK : LIGHT
        const bottom = dark(x, y + 1) ? DARK : LIGHT
        if (top === bottom) {
          if (bg !== top) line += `\x1b[48;5;${(bg = top)}m`
          line += ' '
          continue
        }
        const set: string[] = []
        if (fg !== top) set.push(`38;5;${(fg = top)}`)
        if (bg !== bottom) set.push(`48;5;${(bg = bottom)}`)
        if (set.length) line += `\x1b[${set.join(';')}m`
        line += '▀'
      }
      lines.push(line + RESET)
    }
  } else {
    for (let y = 0; y < span; y++) {
      let line = ''
      let current: boolean | null = null
      for (let x = 0; x < span; x++) {
        const d = dark(x, y)
        if (d !== current) {
          line += `\x1b[48;5;${d ? DARK : LIGHT}m`
          current = d
        }
        line += '  '
      }
      lines.push(line + RESET)
    }
  }
  return lines
}

/** One full screen update: symbol centered above a single status row. */
export function composeScreen(symbol: string[], symbolSize: Size, term: Size, status: string): string {
  const top = Math.max(0, Math.floor((term.rows - 1 - symbolSize.rows) / 2))
  const left = Math.max(0, Math.floor((term.cols - symbolSize.cols) / 2))
  let out = SYNC_BEGIN
  symbol.forEach((line, i) => {
    out += `\x1b[${top + i + 1};${left + 1}H${line}`
  })
  out += `\x1b[${term.rows};1H\x1b[2K${RESET}${fitWidth(status, term.cols - 1)}`
  return out + SYNC_END
}

/** East Asian wide/fullwidth code points occupy two terminal columns. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** Truncate to at most `columns` display columns (UTF-16 length undercounts Hangul/CJK). */
export function fitWidth(text: string, columns: number): string {
  let width = 0
  let out = ''
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (width + w > columns) break
    width += w
    out += ch
  }
  return out
}

// Autowrap is disabled while sending so an over-long line can never scroll the symbol.
export const screen = {
  enter: '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J',
  clear: '\x1b[2J',
  leave: `${RESET}\x1b[?7h\x1b[?25h\x1b[?1049l`,
}
