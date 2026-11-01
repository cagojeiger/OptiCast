// Runs the real `opticast send` process in a tmux pane (a real TTY), captures
// the pane's screen once per displayed frame, decodes the captures, and checks
// that they reassemble into the original file.
//
// usage: node tools/probe/tmux-cli.ts [file]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import jsQR from 'jsqr'
import { Assembler, equalBytes, transferIdHex } from '../../src/core/index.ts'
import { toRgba } from '../sim/camera.ts'
import { VTerm } from '../sim/vterm.ts'

const file = process.argv[2] ?? 'samples/approved.json'
const session = `opticast-probe-${process.pid}`
const fps = 2
const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '40', process.execPath, 'src/sender/cli.ts', 'send', file, '--fps', String(fps))
// window-size options (e.g. `latest`) can override -x/-y, so ask for the real pane size.
const [cols, rows] = tmux('display', '-p', '-t', session, '#{pane_width} #{pane_height}').trim().split(' ').map(Number)
const size = { cols: cols!, rows: rows! }
console.log(`pane      ${size.cols}x${size.rows}`)
const assembler = new Assembler()
let captures = 0
try {
  await sleep(800)
  for (let i = 0; i < 40 && !assembler.complete; i++) {
    const screen = tmux('capture-pane', '-p', '-e', '-N', '-t', session) // -N keeps trailing (quiet-zone) spaces
    captures++
    const vt = new VTerm(size)
    screen.split('\n').forEach((line, row) => vt.write(`\x1b[${row + 1};1H\x1b[0m${line}`))
    const img = vt.rasterize()
    const code = jsQR(toRgba(img), img.width, img.height, { inversionAttempts: 'dontInvert' })
    const status = code ? assembler.accept(new Uint8Array(code.binaryData)).kind : 'no-symbol'
    const statusLine = screen.trimEnd().split('\n').pop()?.replace(/\x1b\[[0-9;]*m/g, '').trim()
    console.log(`capture ${String(captures).padStart(2)}  ${status.padEnd(9)}  ${statusLine?.slice(0, 90)}`)
    await sleep(1000 / fps)
  }
  tmux('send-keys', '-t', session, 'q')
  await sleep(500)
  let alive = true
  try {
    tmux('has-session', '-t', session)
  } catch {
    alive = false
  }
  console.log(`after q   sender ${alive ? 'STILL RUNNING' : 'exited'}`)
} finally {
  try {
    tmux('kill-session', '-t', session)
  } catch {}
}

if (!assembler.complete) {
  console.log(`FAIL  ${assembler.received}/${assembler.blockCount} blocks after ${captures} captures`)
  process.exit(1)
}
const { data, envelope } = await assembler.finalize()
const ok = equalBytes(data, new Uint8Array(readFileSync(file)))
console.log(`${ok ? 'PASS' : 'FAIL'}  ${envelope.filename} ${data.length} B, transfer ${transferIdHex(assembler.transferId!)}, ${captures} captures`)
process.exit(ok ? 0 : 1)
