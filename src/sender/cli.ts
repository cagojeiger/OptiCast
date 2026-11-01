#!/usr/bin/env node
// OptiCast sender CLI. Runs on Node ≥ 22.18 directly from TypeScript (type stripping).

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { parseArgs } from 'node:util'
import { Compression, DEFAULT_META_EVERY, prepareTransfer, transferIdHex, type PreparedTransfer } from '../core/index.ts'
import { fitVersion, geometry, MIN_BLOCK_SIZE, minUsableVersion, type Geometry } from './plan.ts'
import { encodeSymbol, MAX_VERSION, MIN_VERSION, type Ecc } from './qr.ts'
import { composeScreen, renderSymbol, screen, type RenderMode, type Size } from './terminal.ts'

const HELP = `opticast — broadcast a file as a looping optical signal in the terminal

usage
  opticast send <file> [options]   loop the file's frames on screen until q
  opticast plan <file> [options]   print frame geometry and timing, no rendering

options
  --fps <n>           frames per second (default 2; +/- while sending)
  --ecc <L|M|Q|H>     QR error correction level (default M)
  --qr-version <n>    fixed QR version 1–40 (default: largest that fits the terminal)
  --max-version <n>   cap for the automatic version (default 10)
  --quiet <n>         quiet-zone width in modules (default 2)
  --render <mode>     half: ▀▄█ glyphs (default) | bg: colored spaces, no glyphs
  --meta-every <n>    send a META frame before every n-th data frame (default ${DEFAULT_META_EVERY})
  --no-compress       never deflate
  --max-bytes <n>     refuse inputs larger than n bytes (default 1048576)
  --cycles <n>        stop after n full cycles (default: loop forever)
  --mime <type>       override the MIME type
  -h, --help          show this help

keys while sending
  + / -   faster / slower      space   pause      q   quit`

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
}

const FPS_STEPS = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]

class UsageError extends Error {}

interface Options {
  fps: number
  ecc: Ecc
  qrVersion: number | undefined
  maxVersion: number
  quiet: number
  mode: RenderMode
  metaEvery: number
  compress: boolean
  maxBytes: number
  cycles: number | undefined
  mime: string | undefined
}

function parse(argv: string[]): { command: string | undefined; file: string | undefined; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fps: { type: 'string', default: '2' },
      ecc: { type: 'string', default: 'M' },
      'qr-version': { type: 'string' },
      'max-version': { type: 'string', default: '10' },
      quiet: { type: 'string', default: '2' },
      render: { type: 'string', default: 'half' },
      'meta-every': { type: 'string', default: String(DEFAULT_META_EVERY) },
      'no-compress': { type: 'boolean', default: false },
      'max-bytes': { type: 'string', default: String(1024 * 1024) },
      cycles: { type: 'string' },
      mime: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    process.exit(0)
  }
  const ecc = values.ecc.toUpperCase()
  if (ecc !== 'L' && ecc !== 'M' && ecc !== 'Q' && ecc !== 'H') throw new UsageError(`--ecc must be L, M, Q or H`)
  if (values.render !== 'half' && values.render !== 'bg') throw new UsageError(`--render must be half or bg`)
  return {
    command: positionals[0],
    file: positionals[1],
    options: {
      fps: number('--fps', values.fps, 0.1, 60),
      ecc,
      qrVersion: values['qr-version'] === undefined ? undefined : integer('--qr-version', values['qr-version'], MIN_VERSION, MAX_VERSION),
      maxVersion: integer('--max-version', values['max-version'], MIN_VERSION, MAX_VERSION),
      quiet: integer('--quiet', values.quiet, 0, 10),
      mode: values.render,
      metaEvery: integer('--meta-every', values['meta-every'], 1, 10_000),
      compress: !values['no-compress'],
      maxBytes: integer('--max-bytes', values['max-bytes'], 0, 2 ** 32 - 1),
      cycles: values.cycles === undefined ? undefined : integer('--cycles', values.cycles, 1, 1_000_000),
      mime: values.mime,
    },
  }
}

function number(flag: string, raw: string, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}`)
  return n
}

function integer(flag: string, raw: string, min: number, max: number): number {
  const n = number(flag, raw, min, max)
  if (!Number.isInteger(n)) throw new UsageError(`${flag} must be an integer`)
  return n
}

function terminalSize(): Size | null {
  const { columns, rows } = process.stdout
  return process.stdout.isTTY && columns && rows ? { cols: columns, rows } : null
}

interface Loaded {
  name: string
  data: Uint8Array
  geo: Geometry
  prepared: PreparedTransfer
}

async function load(file: string, opts: Options, term: Size | null): Promise<Loaded> {
  const data = new Uint8Array(await readFile(file))
  if (data.length > opts.maxBytes) {
    throw new UsageError(`${file} is ${data.length} bytes; --max-bytes allows ${opts.maxBytes}`)
  }
  const geoOpts = { ecc: opts.ecc, quiet: opts.quiet, mode: opts.mode }
  const version = opts.qrVersion ?? (term ? fitVersion(term, opts.maxVersion, geoOpts) : opts.maxVersion)
  const minVersion = minUsableVersion(opts.ecc)
  if (opts.qrVersion !== undefined && opts.qrVersion < minVersion) {
    throw new UsageError(`QR v${opts.qrVersion}-${opts.ecc} is too small to carry the envelope; use --qr-version ${minVersion} or larger`)
  }
  if (version === null || version < minVersion) {
    const need = geometry(minVersion, geoOpts).footprint
    throw new UsageError(
      `terminal ${term?.cols}x${term?.rows} is too small: QR v${minVersion}-${opts.ecc} needs ${need.cols}x${need.rows + 1} cells` +
        (opts.mode === 'bg' ? ' (try --render half)' : ''),
    )
  }
  const geo = geometry(version, geoOpts)
  if (geo.blockSize < MIN_BLOCK_SIZE) throw new UsageError(`QR v${version}-${opts.ecc} is too small to carry the envelope`)
  const name = basename(file)
  const prepared = await prepareTransfer(data, {
    filename: name,
    mime: opts.mime ?? MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
    blockSize: geo.blockSize,
    compress: opts.compress ? 'auto' : 'never',
    metaEvery: opts.metaEvery,
  })
  return { name, data, geo, prepared }
}

function formatBytes(n: number): string {
  if (Math.round(n) < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function plan(loaded: Loaded, opts: Options): void {
  const { name, geo, prepared } = loaded
  const { envelope } = prepared
  const metaFrames = prepared.cycle.length - prepared.blockCount
  const seconds = prepared.cycle.length / opts.fps
  const rows: [string, string][] = [
    ['file', `${name} (${envelope.mime || 'no mime'})`],
    [
      'size',
      `${formatBytes(envelope.size)}` +
        (envelope.compression === Compression.Deflate ? ` -> ${formatBytes(envelope.encodedSize)} deflate` : ' (uncompressed)'),
    ],
    ['transfer', transferIdHex(prepared.transferId)],
    ['frame', `QR v${geo.version}-${geo.ecc}, ${geo.modules}x${geo.modules} modules, ${geo.capacity} B/frame, ${geo.blockSize} B payload`],
    ['footprint', `${geo.footprint.cols}x${geo.footprint.rows + 1} terminal cells (${geo.mode}, quiet ${geo.quiet})`],
    ['cycle', `${prepared.blockCount} data + ${metaFrames} meta = ${prepared.cycle.length} frames`],
    ['duration', `${seconds.toFixed(1)} s per cycle at ${opts.fps} fps (~${formatBytes(envelope.size / seconds)}/s)`],
  ]
  for (const [k, v] of rows) console.log(`${k.padEnd(10)} ${v}`)
}

async function send(loaded: Loaded, opts: Options): Promise<void> {
  const { name, geo, prepared } = loaded
  const out = process.stdout
  const stdin = process.stdin
  // Each cycle shows the same bytes under the next QR mask, so a symbol the receiver's
  // fixed pose cannot read is not repeated verbatim forever. Cached for one cycle only.
  const rendered = new Map<number, string[]>()
  const symbolLines = (i: number) => {
    let lines = rendered.get(i)
    if (!lines) {
      lines = renderSymbol(encodeSymbol(prepared.cycle[i]!, geo.version, geo.ecc, cycle), geo.quiet, geo.mode)
      rendered.set(i, lines)
    }
    return lines
  }

  let index = 0
  let cycle = 0
  let shown = 0
  let fps = opts.fps
  let paused = false
  let timer: NodeJS.Timeout | undefined
  let finished = false

  const status = () =>
    [
      ` OptiCast  ${name} ${formatBytes(prepared.envelope.size)}`,
      `id ${transferIdHex(prepared.transferId)}`,
      `QR v${geo.version}-${geo.ecc}`,
      `frame ${index + 1}/${prepared.cycle.length}`,
      `cycle ${cycle + 1}`,
      paused ? 'PAUSED' : `${fps} fps`,
      '[+/-] fps  [space] pause  [q] quit',
    ].join('  |  ')

  const draw = () => {
    const term = terminalSize() ?? { cols: geo.footprint.cols, rows: geo.footprint.rows + 1 }
    if (term.cols < geo.footprint.cols || term.rows - 1 < geo.footprint.rows) {
      out.write(`${screen.clear}\x1b[1;1Hterminal too small: need ${geo.footprint.cols}x${geo.footprint.rows + 1}, have ${term.cols}x${term.rows}`)
      return
    }
    out.write(composeScreen(symbolLines(index), geo.footprint, term, status()))
  }

  const restore = () => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
    out.write(screen.leave)
    console.log(
      `opticast: showed ${shown} frames (${cycle} full cycles of ${prepared.cycle.length}), transfer ${transferIdHex(prepared.transferId)}`,
    )
  }

  const tick = () => {
    if (paused) return
    draw()
    shown++
    index++
    if (index === prepared.cycle.length) {
      index = 0
      cycle++
      rendered.clear()
      if (opts.cycles !== undefined && cycle >= opts.cycles) {
        restore()
        return
      }
    }
    timer = setTimeout(tick, 1000 / fps)
  }

  const setFps = (direction: 1 | -1) => {
    const next = direction > 0 ? FPS_STEPS.find((s) => s > fps) : FPS_STEPS.findLast((s) => s < fps)
    if (next === undefined) return
    fps = next
    if (!paused) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, 1000 / fps) // apply the new rate now, not after the old delay
    }
  }

  process.on('exit', restore)
  process.on('uncaughtException', (err) => {
    restore() // leave the alternate screen first, or the stack trace is erased with it
    console.error(err)
    process.exit(1)
  })
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.on(signal, () => {
      restore()
      process.exit(code)
    })
  }
  out.on('resize', () => {
    out.write(screen.clear)
    draw()
  })
  if (stdin.isTTY) {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', (key: Buffer) => {
      const k = key.toString()
      if (k === 'q' || k === '\x1b') {
        restore()
        process.exit(0)
      } else if (k === '\x03') {
        restore()
        process.exit(130) // raw mode turns Ctrl-C into a byte; keep the shell's SIGINT exit code
      } else if (k === '+' || k === '=') setFps(1)
      else if (k === '-' || k === '_') setFps(-1)
      else if (k === ' ') {
        paused = !paused
        if (paused) {
          if (timer) clearTimeout(timer)
          draw()
        } else tick()
        return
      }
      draw()
    })
  }

  out.write(screen.enter)
  tick()
}

async function main(): Promise<void> {
  const { command, file, options } = parse(process.argv.slice(2))
  if (!command || !file || (command !== 'send' && command !== 'plan')) throw new UsageError('expected: send <file> | plan <file>')
  const term = terminalSize()
  if (command === 'send' && !term) throw new UsageError('send needs an interactive terminal (stdout is not a TTY)')
  const loaded = await load(file, options, term)
  if (command === 'plan') plan(loaded, options)
  else await send(loaded, options)
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`opticast: ${err.message}\nrun with --help for usage`)
    process.exit(2)
  }
  console.error(err)
  process.exit(1)
})
