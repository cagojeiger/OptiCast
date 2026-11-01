// Minimal virtual terminal: replays the exact ANSI bytes the sender writes and
// rasterizes the resulting cell grid to grayscale pixels, so tests exercise the
// real terminal path (escape codes, half-block glyphs, centering), not just the matrix.

export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

interface Cell {
  ch: string
  fg: number
  bg: number
}

export interface VTermOptions {
  cols: number
  rows: number
  /** Gray level of the terminal's default foreground/background (a dark theme by default). */
  defaultFg?: number
  defaultBg?: number
}

export interface RasterOptions {
  cellWidth?: number
  cellHeight?: number
  /** Pixel rows at the bottom of each cell left in background color, like fonts whose blocks don't fill the line. */
  lineGap?: number
}

function xterm256ToGray(n: number): number {
  if (n < 16) return [0, 128, 128, 128, 0, 128, 0, 192, 128, 255, 255, 255, 92, 255, 255, 255][n]!
  if (n < 232) {
    const level = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    const r = level[Math.floor(i / 36)]!
    const g = level[Math.floor(i / 6) % 6]!
    const b = level[i % 6]!
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return 8 + (n - 232) * 10
}

export class VTerm {
  readonly cols: number
  readonly rows: number
  private readonly defaultFg: number
  private readonly defaultBg: number
  private cells: Cell[]
  private x = 0
  private y = 0
  private fg: number
  private bg: number
  /** SGR 7: cells are stored with foreground and background swapped. */
  private inverse = false

  constructor(opts: VTermOptions) {
    this.cols = opts.cols
    this.rows = opts.rows
    this.defaultFg = opts.defaultFg ?? 220
    this.defaultBg = opts.defaultBg ?? 24
    this.fg = this.defaultFg
    this.bg = this.defaultBg
    this.cells = this.blank()
  }

  private blank(): Cell[] {
    return Array.from({ length: this.cols * this.rows }, () => ({ ch: ' ', fg: this.defaultFg, bg: this.defaultBg }))
  }

  write(text: string): void {
    const re = /\x1b\[([?0-9;]*)([A-Za-z])/y
    let i = 0
    while (i < text.length) {
      if (text[i] === '\x1b') {
        re.lastIndex = i
        const m = re.exec(text)
        if (!m) throw new Error(`unsupported escape at ${i}: ${JSON.stringify(text.slice(i, i + 8))}`)
        this.control(m[1]!, m[2]!)
        i = re.lastIndex
        continue
      }
      const ch = String.fromCodePoint(text.codePointAt(i)!)
      i += ch.length
      const [fg, bg] = this.inverse ? [this.bg, this.fg] : [this.fg, this.bg]
      if (this.x < this.cols && this.y < this.rows) this.cells[this.y * this.cols + this.x] = { ch, fg, bg }
      this.x++
    }
  }

  private control(args: string, op: string): void {
    if (args.startsWith('?')) return // private modes (alt screen, cursor, synchronized output)
    const nums = args === '' ? [] : args.split(';').map(Number)
    switch (op) {
      case 'H':
        this.y = (nums[0] ?? 1) - 1
        this.x = (nums[1] ?? 1) - 1
        break
      case 'J':
        if (nums[0] === 2) this.cells = this.blank()
        break
      case 'K':
        for (let x = 0; x < this.cols; x++) this.cells[this.y * this.cols + x] = { ch: ' ', fg: this.defaultFg, bg: this.defaultBg }
        break
      case 'm':
        this.sgr(nums.length ? nums : [0])
        break
      default:
        throw new Error(`unsupported CSI ${op}`)
    }
  }

  private sgr(nums: number[]): void {
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!
      if (n === 0) {
        this.fg = this.defaultFg
        this.bg = this.defaultBg
        this.inverse = false
      } else if (n === 7) this.inverse = true
      else if (n === 27) this.inverse = false
      else if ((n === 38 || n === 48) && nums[i + 1] === 5) {
        const gray = xterm256ToGray(nums[i + 2]!)
        if (n === 38) this.fg = gray
        else this.bg = gray
        i += 2
      } else if (n === 39) this.fg = this.defaultFg
      else if (n === 49) this.bg = this.defaultBg
      else if (n >= 30 && n <= 37) this.fg = xterm256ToGray(n - 30)
      else if (n >= 90 && n <= 97) this.fg = xterm256ToGray(n - 90 + 8)
      else if (n >= 40 && n <= 47) this.bg = xterm256ToGray(n - 40)
      else if (n >= 100 && n <= 107) this.bg = xterm256ToGray(n - 100 + 8)
    }
  }

  rasterize(opts: RasterOptions = {}): GrayImage {
    const cw = opts.cellWidth ?? 8
    const chh = opts.cellHeight ?? 16
    const gap = opts.lineGap ?? 0
    const width = this.cols * cw
    const height = this.rows * chh
    const ink = (ch: string, px: number, py: number): boolean => {
      if (py >= chh - gap) return false
      switch (ch) {
        case ' ':
          return false
        case '█':
          return true
        case '▀':
          return py < chh / 2
        case '▄':
          return py >= chh / 2
        default:
          return px < cw * 0.6 && py > chh * 0.25 && py < chh * 0.75 // any other glyph: a rough ink blob
      }
    }
    const data = new Uint8Array(width * height)
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { ch, fg, bg } = this.cells[row * this.cols + col]!
        for (let py = 0; py < chh; py++) {
          const offset = (row * chh + py) * width + col * cw
          for (let px = 0; px < cw; px++) data[offset + px] = ink(ch, px, py) ? fg : bg
        }
      }
    }
    return { width, height, data }
  }
}
