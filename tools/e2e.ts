// End-to-end test of the receiver without a phone.
//
// 1. `diodecam frames` (the real Rust sender) writes consecutive frames' ANSI
//    text for a random file, starting mid-stream.
// 2. Each frame is replayed in the virtual terminal (tools/sim/vterm.ts, `▀` +
//    SGR 7, 2 px line gap) and filmed by a simulated 30 fps camera watching a
//    24 fps sender: the frame on screen at time t is ⌊24t⌋, and a capture made
//    while the terminal repaints is torn (top rows already show the next
//    frame). Tilt, blur 1, noise σ 8 → a .y4m clip.
// 3. Builds the wasm, serves web/ (tools/serve.ts), opens it in real Chrome with
//    the clip as the fake camera, waits for the verified download and
//    byte-compares it. Any page or console error fails the run.
//
// Chrome loops the clip verbatim, so it holds more than 1.3·(K + 2) distinct
// symbols: a symbol lost in one loop is lost in every loop.
//
// usage: node tools/e2e.ts [--cols 200 --rows 55] [--size 150000] [--camera 1280x720|1920x1080]
//                          [--noise 8] [--blur 1] [--timeout 180] [--headed] [--keep] [--scan W]
//                          [--reload-after S]   (reload mid-transfer; collected tiles resume from IndexedDB)
//                          [--url URL]          (test a deployed receiver instead of building and serving web/)
//                          [--resize-to CxR]    (terminal resized halfway through the clip, and back as it loops)
//                          [--hold S]           (keep the browser open S seconds after the result; screenshots in dist/e2e)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { cargo } from './cargo.ts'
import { serve } from './serve.ts'
import { cameraView, framing, tear } from './sim/camera.ts'
import { randomBytes, senderFrames } from './sim/sender.ts'
import { VTerm, type GrayImage } from './sim/vterm.ts'
import { Y4mWriter } from './sim/y4m.ts'

const { values: args } = parseArgs({
  options: {
    cols: { type: 'string', default: '200' },
    rows: { type: 'string', default: '55' },
    size: { type: 'string', default: '150000' },
    camera: { type: 'string', default: '1280x720' },
    'camera-fps': { type: 'string', default: '30' },
    'sender-fps': { type: 'string', default: '24' },
    'paint-ms': { type: 'string', default: '16' }, // terminal repaint time: captures inside it are torn
    noise: { type: 'string', default: '8' },
    blur: { type: 'string', default: '1' },
    margin: { type: 'string', default: '1.3' }, // distinct symbols in the clip ÷ (K + 2)
    timeout: { type: 'string', default: '180' },
    scan: { type: 'string' },
    url: { type: 'string' }, // receiver to test, e.g. https://cagojeiger.github.io/diodecam/ (default: local build)
    'resize-to': { type: 'string' }, // CxR: resize the terminal halfway through the clip
    hold: { type: 'string' }, // keep the browser open S seconds after the result (with --headed)
    'reload-after': { type: 'string' }, // reload the page after S seconds: progress must resume from IndexedDB
    headed: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
})

const OUT = resolve('dist/e2e')
mkdirSync(OUT, { recursive: true })
const cols = Number(args.cols)
const rows = Number(args.rows)
const [camW, camH] = args.camera.split('x').map(Number)
if (!camW || !camH) throw new Error(`--camera must be WxH, got ${args.camera}`)
const cameraFps = Number(args['camera-fps'])
const senderFps = Number(args['sender-fps'])
const paintMs = Number(args['paint-ms'])
const label = `${cols}x${rows}${args['resize-to'] ? `<->${args['resize-to']}` : ''} @${camW}x${camH}`

// --- 1. sender ------------------------------------------------------------------------
console.log(`build    diodecam-cli, diodecam-wasm`)
cargo(['build', '-q', '-p', 'diodecam-cli'])
const original = randomBytes(Number(args.size), cols * 1000 + rows)

// Probe the layout first (one frame), then size the clip from it.
const sender = { bytes: original, name: 'random.bin' }
const probe = (c: number, r: number) => senderFrames({ ...sender, cols: c, rows: r, count: 1 }).header
const render = (c: number, r: number, count: number, from: number): string[] => senderFrames({ ...sender, cols: c, rows: r, count, skip: from }).frames
const dataTiles = (t: number) => t - 1 / Math.max(1, Math.ceil(10 / t)) // tiles minus the META share
const header = probe(cols, rows)
const tiles = header.tiles
const k = header.source_symbols
const dataPerFrame = dataTiles(tiles)
// --resize-to CxR: the second half of the clip comes from a terminal of that size, continuing the
// same broadcast (the symbol counter carries on), as if the window were resized mid-transfer.
// The clip loops, so the receiver sees the size change back and forth.
const resizeTo = args['resize-to']?.split('x').map(Number)
const halves = resizeTo ? 2 : 1
const frameCount = Math.ceil((Number(args.margin) * (k + 2)) / halves / dataPerFrame) + 2
const skip = Math.floor(k / dataPerFrame / 2) // join halfway through the source pass
const frames = render(cols, rows, frameCount, skip)
console.log(
  `sender   ${original.length} B, id ${header.id}, ${header.profile} ${header.width}x${header.height}, ${tiles} tiles/frame, ` +
    `K = ${k}; clip = frames ${skip}..${skip + frameCount - 1} (${((frameCount * dataPerFrame) / (k + 2)).toFixed(2)}·(K+2) symbols)`,
)
let [termCols, termRows] = [cols, rows]
if (resizeTo) {
  const [cols2, rows2] = resizeTo
  if (!cols2 || !rows2) throw new Error(`--resize-to must be CxR, got ${args['resize-to']}`)
  const header2 = probe(cols2, rows2)
  const count2 = Math.ceil((Number(args.margin) * (k + 2)) / 2 / dataTiles(header2.tiles)) + 2
  const skip2 = Math.ceil(((skip + frameCount) * tiles) / header2.tiles) // first symbol after the first half
  frames.push(...render(cols2, rows2, count2, skip2))
  termCols = Math.max(cols, cols2)
  termRows = Math.max(rows, rows2)
  console.log(
    `resize   -> ${cols2}x${rows2}: ${header2.width}x${header2.height}, ${header2.tiles} tiles/frame, id ${header2.id}; ` +
      `frames ${skip2}..${skip2 + count2 - 1}; camera sees a ${termCols}x${termRows} window area`,
  )
}

// --- 2. camera --------------------------------------------------------------------------
const screens = new Map<number, GrayImage>()
const screen = (j: number): GrayImage => {
  let s = screens.get(j)
  if (!s) {
    // Every frame rewrites all grid and status rows, so a fresh terminal shows it exactly. After a
    // resize the smaller window leaves the rest of the camera's view blank.
    const vt = new VTerm({ cols: termCols, rows: termRows })
    vt.write(frames[j]!)
    s = vt.rasterize({ lineGap: 2 })
    screens.set(j, s)
    for (const key of screens.keys()) if (key !== 0 && key < j - 1) screens.delete(key)
  }
  return s
}
const first = screen(0)
const corners = framing(camW, camH, first.width / first.height, 0.86, 0.05)
const y4mPath = resolve(OUT, `camera-${cols}x${rows}-${camH}p.y4m`)
const video = new Y4mWriter(y4mPath, camW, camH, cameraFps)
const clipFrames = frames.length
const duration = clipFrames / senderFps
const captures = Math.ceil(duration * cameraFps)
let torn = 0
const simStart = Date.now()
for (let c = 0; c < captures; c++) {
  // Mid-exposure time of capture c; frame j is on screen from j/24 s, painted top-down over paintMs.
  const t = (c + 0.5) / cameraFps
  const j = Math.floor(t * senderFps) % clipFrames
  const since = (t - Math.floor(t * senderFps) / senderFps) * 1000
  let shown = screen(j)
  if (since < paintMs) {
    // Repaint in progress: rows above the boundary are frame j, the rest still frame j − 1.
    const older = screen((j + clipFrames - 1) % clipFrames)
    shown = tear(shown, older, Math.floor((since / paintMs) * shown.height))
    torn++
  }
  video.write(cameraView(shown, { width: camW, height: camH, corners, blur: Number(args.blur), noise: Number(args.noise), levels: [40, 215], seed: c + 1 }))
}
video.close()
console.log(
  `camera   ${video.frames} frames @ ${cameraFps} fps = ${(video.frames / cameraFps).toFixed(1)} s loop, ${torn} torn ` +
    `(${Math.round((torn / video.frames) * 100)}%), σ=${args.noise}, blur ${args.blur}, sim ${((Date.now() - simStart) / 1000).toFixed(1)} s`,
)

// --- 3. receiver ---------------------------------------------------------------------------
// --url tests an already deployed receiver (e.g. GitHub Pages) instead of web/.
let server: Awaited<ReturnType<typeof serve>> | undefined
let url = args.url
if (!url) {
  await import('./wasm-build.ts')
  server = await serve('web', 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !args.headed,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4mPath}`],
})
let exitCode = 1
const result: Record<string, unknown> = { label, bytes: original.length, k, tiles, captures: video.frames, torn }
try {
  const context = await browser.newContext({ permissions: ['camera'], acceptDownloads: true })
  const page = await context.newPage()
  let errors = 0
  const pageError = (text: string) => {
    errors++
    console.error(text)
  }
  page.on('pageerror', (err) => pageError(`page error: ${err.message}`))
  page.on('console', (msg) => msg.type() === 'error' && pageError(`console: ${msg.text()}`))
  // Desktop Chrome would get the setup page: force the receiver.
  await page.goto(`${url}?receiver=1&debug=1${args.scan ? `&scan=${args.scan}` : ''}`)
  // Stats live in a sheet; its text is readable without opening it.
  await page.getByTestId('start').click()
  const startedAt = Date.now()
  const samples: { recognition: number; ms: number }[] = []
  let ticks = 0
  const ticker = setInterval(async () => {
    if (++ticks === 2) page.screenshot({ path: resolve(OUT, 'receiver-progress.png') }).catch(() => {})
    const text = (id: string) => page.getByTestId(id).textContent().catch(() => '?')
    const [symbols, recognition, ms, proc, capture, status] = await Promise.all(
      ['symbols', 'recognition', 'decode-ms', 'process-fps', 'capture-fps', 'status'].map(text),
    )
    const r = Number.parseFloat(recognition ?? '')
    const m = Number.parseFloat(ms ?? '')
    if (Number.isFinite(r) && Number.isFinite(m)) samples.push({ recognition: r, ms: m })
    const t = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(3)
    console.log(`receiver ${t} s  ${symbols}  tiles ${recognition}  decode ${ms}  process ${proc}  capture ${capture}  | ${status}`)
  }, 2000)
  try {
    if (args['reload-after']) {
      await page.waitForTimeout(Number(args['reload-after']) * 1000)
      const before = await page.getByTestId('symbols').textContent()
      await page.reload()
      await page.getByTestId('start').click()
      await page.getByTestId('strip-extra').getByText('resumed').waitFor({ timeout: 15_000 })
      const status = await page.getByTestId('strip').textContent()
      console.log(`reload   before: ${before}; after reload: ${status}`)
      result.resumed = status
    }
    await page.locator('#download:enabled').waitFor({ timeout: Number(args.timeout) * 1000 })
  } finally {
    clearInterval(ticker)
  }
  const seconds = (Date.now() - startedAt) / 1000
  const stats = JSON.parse((await page.getByTestId('debug').textContent()) ?? '{}')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()])
  const savedPath = resolve(OUT, download.suggestedFilename())
  await download.saveAs(savedPath)
  const received = new Uint8Array(readFileSync(savedPath))
  const identical = received.length === original.length && Buffer.from(received).equals(Buffer.from(original))
  // The verified file stays until the next one or a reset: a reload offers it again.
  await page.reload()
  const kept = await page.getByTestId('strip').getByText('Received').waitFor({ timeout: 10_000 }).then(() => true, () => false)
  console.log(`reload   kept file offered again: ${kept}`)
  const ok = identical && kept && errors === 0
  const overall = stats.totals?.tiles ? stats.totals.tiles_ok / stats.totals.tiles : 0
  const avgMs = samples.length ? samples.reduce((a, s) => a + s.ms, 0) / samples.length : 0
  const avgRecognition = samples.length ? samples.reduce((a, s) => a + s.recognition, 0) / samples.length : 0
  Object.assign(result, {
    ok,
    errors,
    seconds,
    loops: seconds / duration,
    recognition: overall,
    recognitionShown: avgRecognition / 100,
    decodeMs: avgMs,
    kept,
    framesProcessed: stats.totals?.frames,
    detections: stats.totals?.detections,
    symbols: stats.symbols,
  })
  console.log(`result   ${(await page.getByTestId('strip').textContent())?.replace(/\s+/g, ' ').trim()} · ${(await page.getByTestId('file-name').textContent())?.trim()}`)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}     ${label}: ${download.suggestedFilename()} ${received.length} B in ${seconds.toFixed(1)} s ` +
      `(${(seconds / duration).toFixed(2)} clip loops), tile recognition ${(overall * 100).toFixed(1)}% over ` +
      `${stats.totals?.frames} frames (grid in ${stats.totals?.detections}), decode ${avgMs.toFixed(1)} ms, byte-identical: ${identical}, page errors: ${errors}`,
  )
  exitCode = ok ? 0 : 1
  await page.screenshot({ path: resolve(OUT, 'receiver-done.png') })
  if (args.hold) await page.waitForTimeout(Number(args.hold) * 1000)
} catch (err) {
  console.error(`FAIL     ${label}: ${(err as Error).message}`)
} finally {
  await browser.close()
  server?.close()
  writeFileSync(resolve(OUT, `result-${cols}x${rows}-${camH}p.json`), JSON.stringify(result, null, 2))
  if (!args.keep) rmSync(y4mPath, { force: true })
}
process.exit(exitCode)
