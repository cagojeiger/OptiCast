// End-to-end concept test without a phone.
//
// 1. Encodes a sample file exactly as `opticast send` does and replays the
//    sender's ANSI output in a virtual terminal (with a line-gap font).
// 2. Films it with a synthetic camera (tilt, defocus, noise, glare) into a
//    looping .y4m that starts mid-cycle and includes torn half-redrawn frames.
// 3. Builds the receiver, serves it, and opens it in real Chrome with that
//    video as the fake camera.
// 4. Waits for the verified download and compares it byte-for-byte.
//
// usage: node tools/e2e-fake-camera.ts [--headed] [--noise 8] [--sender-fps 5] [--qr-version 8] [--items 80]
//                                      [--camera 960x540] [--camera-fps 10] [--scan 960] [--cycles 1] [--cpu-throttle 1]
//
// Chrome loops the fake-camera file verbatim, so a frame that fails to decode in
// one loop fails in every loop. A real camera never shows the same noise twice;
// --cycles N films N passes with fresh noise so a miss can be made up next pass.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'
import { equalBytes, prepareTransfer, toHex, transferIdHex } from '../src/core/index.ts'
import { geometry } from '../src/sender/plan.ts'
import { encodeSymbol } from '../src/sender/qr.ts'
import { composeScreen, renderSymbol } from '../src/sender/terminal.ts'
import { randomBytes } from '../test/helpers.ts'
import { cameraView, framing } from './sim/camera.ts'
import { VTerm, type GrayImage } from './sim/vterm.ts'
import { Y4mWriter } from './sim/y4m.ts'

const { values: args } = parseArgs({
  options: {
    headed: { type: 'boolean', default: false },
    noise: { type: 'string', default: '8' },
    'sender-fps': { type: 'string', default: '5' },
    'qr-version': { type: 'string', default: '8' },
    items: { type: 'string', default: '80' },
    timeout: { type: 'string', default: '120' },
    camera: { type: 'string', default: '960x540' },
    'camera-fps': { type: 'string', default: '10' }, // phones film at 30
    'cpu-throttle': { type: 'string', default: '1' }, // CDP slowdown of the page's main thread (capture); the decode worker is not slowed
    scan: { type: 'string' }, // receiver ?scan= (decode width)
    cycles: { type: 'string', default: '1' }, // broadcast cycles filmed, each with fresh camera noise
  },
})

const OUT = resolve('dist/e2e')
const [cameraWidth, cameraHeight] = args.camera.split('x').map(Number)
if (!cameraWidth || !cameraHeight) throw new Error(`--camera must be WxH, got ${args.camera}`)
const CAMERA = { width: cameraWidth, height: cameraHeight, fps: Number(args['camera-fps']) }
const senderFps = Number(args['sender-fps'])
const hold = Math.round(CAMERA.fps / senderFps) // camera frames per displayed QR frame
// The first camera frame of each QR is torn, so a hold of 1 would film no clean frame at all.
if (!(hold >= 2)) throw new Error(`--sender-fps must be at most ${CAMERA.fps / 2} for a ${CAMERA.fps} fps camera, got ${senderFps}`)
mkdirSync(OUT, { recursive: true })

// --- 1. sender ------------------------------------------------------------------
const items = Array.from({ length: Number(args.items) }, (_, i) => ({
  id: i,
  key: toHex(randomBytes(12, i + 1)),
  approved: i % 3 === 0,
}))
const original = new TextEncoder().encode(JSON.stringify({ exportedAt: '2026-10-31T09:00:00Z', items }, null, 1))
const geo = geometry(Number(args['qr-version']), { ecc: 'M', quiet: 2, mode: 'half' })
const transfer = await prepareTransfer(original, {
  filename: 'approved-export.json',
  mime: 'application/json',
  blockSize: geo.blockSize,
})
const term = { cols: Math.max(100, geo.footprint.cols + 4), rows: geo.footprint.rows + 6 }
console.log(
  `sender   ${original.length} B -> ${transfer.envelope.encodedSize} B, ${transfer.blockCount} blocks + ` +
    `${transfer.cycle.length - transfer.blockCount} meta per cycle, QR v${geo.version}-M, id ${transferIdHex(transfer.transferId)}`,
)

// Like the sender, cycle c shows every frame under the mask rotated by c.
const cycleScreens = new Map<number, GrayImage[]>()
const screenAt = (shown: number): GrayImage => {
  const c = Math.floor(shown / transfer.cycle.length)
  let screens = cycleScreens.get(c)
  if (!screens) {
    screens = transfer.cycle.map((frame, i) => {
      const vt = new VTerm(term)
      const symbol = renderSymbol(encodeSymbol(frame, geo.version, geo.ecc, c), geo.quiet, geo.mode)
      vt.write(composeScreen(symbol, geo.footprint, term, ` OptiCast  frame ${i + 1}/${transfer.cycle.length}  cycle ${c + 1}`))
      return vt.rasterize({ lineGap: 2 })
    })
    cycleScreens.set(c, screens)
    cycleScreens.delete(c - 2) // filming only ever looks one frame back
  }
  return screens[shown % transfer.cycle.length]!
}

// --- 2. camera --------------------------------------------------------------------
const y4mPath = resolve(OUT, 'camera.y4m')
const video = new Y4mWriter(y4mPath, CAMERA.width, CAMERA.height, CAMERA.fps)
const first = screenAt(0)
const corners = framing(CAMERA.width, CAMERA.height, first.width / first.height, 0.85, 0.05)
const shoot = (screen: GrayImage, seed: number) =>
  cameraView(screen, { ...CAMERA, corners, blur: 1, noise: Number(args.noise), levels: [40, 215], seed })
const start = Math.floor(transfer.cycle.length / 2) // receiver "arrives" mid-broadcast
const total = transfer.cycle.length * Number(args.cycles)
// Chrome loops the file, so what the camera saw just before the first frame is the last one written.
const seam = screenAt(start + total - 1)
let seed = 1
for (let k = 0; k < total; k++) {
  const shown = start + k
  const prev = k === 0 ? seam : screenAt(shown - 1)
  const curr = screenAt(shown)
  // First camera frame of each new QR catches the redraw halfway: top new, bottom old.
  const torn = { ...curr, data: prev.data.slice() }
  torn.data.set(curr.data.subarray(0, (curr.height >> 1) * curr.width))
  video.write(shoot(torn, seed++))
  for (let h = 1; h < hold; h++) video.write(shoot(curr, seed++))
}
video.close()
console.log(
  `camera   ${video.frames} frames @ ${CAMERA.fps} fps (${(video.frames / CAMERA.fps).toFixed(1)} s loop, ` +
    `${hold - 1}/${hold} clean per QR, σ=${args.noise}), ${y4mPath}`,
)

// --- 3. receiver ----------------------------------------------------------------------
await build({ configFile: resolve('vite.config.ts'), logLevel: 'warn' })
const server = await preview({ configFile: resolve('vite.config.ts'), logLevel: 'warn', preview: { port: 4173, host: '127.0.0.1' } })
const url = server.resolvedUrls?.local[0]
if (!url) throw new Error('preview server has no URL')

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !args.headed,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4mPath}`],
})
let exitCode = 1
try {
  const context = await browser.newContext({ permissions: ['camera'], acceptDownloads: true })
  const page = await context.newPage()
  const throttle = Number(args['cpu-throttle'])
  if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle })
  page.on('pageerror', (err) => console.error(`page error: ${err.message}`))
  page.on('console', (msg) => msg.type() === 'error' && console.error(`console: ${msg.text()}`))
  await page.goto(args.scan ? `${url}?scan=${args.scan}` : url)
  await page.getByTestId('start').click()
  const startedAt = Date.now()

  const ticker = setInterval(async () => {
    const blocks = await page.getByTestId('blocks').textContent().catch(() => '?')
    const scan = await page.locator('#stat-scan').textContent().catch(() => '?')
    const ms = await page.locator('#stat-ms').textContent().catch(() => '?')
    const status = await page.getByTestId('status').textContent().catch(() => '?')
    console.log(`receiver ${((Date.now() - startedAt) / 1000).toFixed(0).padStart(3)} s  blocks ${blocks}  scan ${scan}  decode ${ms}  | ${status}`)
  }, 3000)
  try {
    await page.getByTestId('download').waitFor({ state: 'visible', timeout: Number(args.timeout) * 1000 })
  } finally {
    clearInterval(ticker)
  }
  const seconds = (Date.now() - startedAt) / 1000
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()])
  const savedPath = resolve(OUT, download.suggestedFilename())
  await download.saveAs(savedPath)
  const received = new Uint8Array(readFileSync(savedPath))
  const stats = await page.locator('.stats').innerText()
  console.log(`result   ${await page.getByTestId('result').textContent()}`)
  console.log(`stats    ${stats.replace(/\s+/g, ' ')}`)
  const ok = equalBytes(received, original)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}     ${download.suggestedFilename()} ${received.length} B in ${seconds.toFixed(1)} s ` +
      `(${(seconds / (video.frames / CAMERA.fps)).toFixed(1)} video loops), byte-identical: ${ok}`,
  )
  writeFileSync(resolve(OUT, 'result.json'), JSON.stringify({ ok, seconds, bytes: received.length }, null, 2))
  exitCode = ok ? 0 : 1
} catch (err) {
  console.error(`FAIL     ${(err as Error).message}`)
} finally {
  await browser.close()
  await server.close()
}
process.exit(exitCode)
