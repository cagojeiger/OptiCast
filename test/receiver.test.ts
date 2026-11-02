// The receiver (web/): the screen's rolling metrics, the resume store's pure
// rules, and the WebAssembly receiver fed with real sender frames through the
// terminal and camera simulators. The wasm test needs `pnpm wasm` and a built
// `diodecam` binary; it is skipped (with a note) when they are missing.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { cameraView, framing, toRgba } from '../tools/sim/camera.ts'
import { VTerm } from '../tools/sim/vterm.ts'
import { MIN_MODULE_PX, eta, failure, formatBytes, fps, hint, limitMib, moduleSize, quantile, recognition, safeName, scanWidth, symbolRate, tooLargeText, trim, type FrameSample, type Stage } from '../web/metrics.js'
import { evictable, exportTiles, type SavedMeta } from '../web/store.js'
import { OUT_OF_MEMORY, WasmReceiver } from '../web/wasm.js'
import { randomBytes } from './helpers.ts'

const frame = (t: number, tilesOk: number, tiles = 10, grid = true): FrameSample => ({ t, grid, tilesOk, tiles })
const miss = (t: number, stage: Stage): FrameSample => ({ t, grid: false, tilesOk: 0, tiles: 0, stage })
const sized = (t: number, tilesOk: number, module: number): FrameSample => ({ ...frame(t, tilesOk), stage: 'done', module })
const close = (actual: number | null, expected: number, within: number) => assert.ok(actual !== null && Math.abs(actual - expected) < within, `${actual} ≉ ${expected}`)

describe('metrics', () => {
  it('keeps only the recent window', () => {
    const s = [0, 500, 1000, 2600, 3000].map((t) => frame(t, 1))
    assert.deepEqual(
      trim(s, 2000).map((f) => f.t),
      [1000, 2600, 3000],
    )
    assert.deepEqual(trim([], 2000), [])
  })

  it('recognition is tiles passed over tiles tried', () => {
    close(recognition([frame(0, 9), frame(1, 10)]), 0.95, 0.005)
    assert.equal(recognition([frame(0, 0, 0, false)]), null)
  })

  it('hints follow the 90 % / 70 % thresholds and the no-grid case', () => {
    assert.equal(hint([frame(0, 9), frame(1, 10)]), 'faster')
    assert.equal(hint([frame(0, 8), frame(1, 8)]), null)
    assert.equal(hint([frame(0, 6), frame(1, 7)]), 'slower')
    assert.equal(hint([frame(0, 0, 0, false), frame(1, 0, 0, false)]), 'aim')
    assert.equal(hint([]), null)
  })

  it('names the stage most frames without a grid stopped at', () => {
    assert.deepEqual(failure([miss(0, 'timing'), miss(1, 'timing'), miss(2, 'finders'), frame(3, 9)]), { stage: 'timing', share: 0.5 })
    assert.equal(failure([frame(0, 9), frame(1, 9)]), null)
    assert.equal(failure([frame(0, 0, 0, false)]), null) // no stage reported
  })

  it('hints follow the failing stage, then module size', () => {
    assert.equal(hint([miss(0, 'finders'), miss(1, 'finders'), frame(2, 9)]), 'aim')
    assert.equal(hint([miss(0, 'format'), miss(1, 'timing'), miss(2, 'timing')]), 'focus')
    assert.equal(hint([miss(0, 'geometry'), miss(1, 'geometry')]), 'straight')
    // Small modules: come closer, or turn a portrait camera sideways.
    const small = [sized(0, 5, 3.2), sized(1, 6, 3.4), sized(2, 5, 3.3)]
    assert.equal(hint(small), 'closer')
    assert.equal(hint(small, true), 'rotate')
    assert.equal(hint([sized(0, 5, 7), sized(1, 6, 7)]), 'slower')
    assert.equal(hint([sized(0, 10, 3.0), sized(1, 10, 3.0)]), 'faster') // small but reading fine
    assert.equal(hint([sized(0, 0, 3.5), miss(1, 'timing'), miss(2, 'timing')]), 'closer')
  })

  it('module size is the shorter pitch across or down', () => {
    // A 100×50 grid, 400×300 px, tilted corners averaged: 4 px across, 6 px down.
    close(moduleSize([10, 10, 410, 10, 410, 310, 10, 310], { w: 100, h: 50 }), 4, 1e-9)
    assert.equal(moduleSize(null, { w: 1, h: 1 }), null)
    assert.equal(moduleSize([0, 0, null, 0, 1, 1, 0, 1], { w: 1, h: 1 }), null)
    assert.ok(MIN_MODULE_PX > 4 && MIN_MODULE_PX < 5)
  })

  it('quantiles by nearest rank, ignoring missing values', () => {
    assert.equal(quantile([3, null, 1, 2], 0.5), 2)
    assert.equal(quantile([5, 1, 4, 2, 3], 0.9), 5)
    assert.equal(quantile([undefined], 0.5), null)
  })

  it('ETA uses the recent symbol rate', () => {
    const rate = symbolRate([
      { t: 0, have: 100 },
      { t: 5000, have: 1100 },
    ])
    assert.equal(rate, 200)
    assert.equal(eta(1100, 3100, rate), 10)
    assert.equal(eta(3200, 3100, rate), 0)
    assert.equal(eta(10, 100, 0), null)
    assert.equal(symbolRate([{ t: 0, have: 1 }]), null)
  })

  it('fps from callback times', () => {
    close(fps([0, 33.3, 66.6, 100, 133.3, 166.6, 200, 233.3, 266.6, 300, 333.3]), 30, 0.5)
    assert.equal(fps([0]), null)
  })

  it('formats sizes in SI units like the sender', () => {
    assert.equal(formatBytes(999), '999 B')
    assert.equal(formatBytes(1_000_000), '1.00 MB')
    assert.equal(formatBytes(41_500), '41.5 KB')
  })

  it('file names are made safe for display and download', () => {
    assert.equal(safeName('../x'), '.._x')
    assert.equal(safeName('a/b\\c'), 'a_b_c')
    assert.equal(safeName('evil‮fdp.exe'), 'evil_fdp.exe')
    assert.equal(safeName('a\u0007b\u001bc'), 'a_b_c')
    assert.equal(safeName(''), 'file')
    assert.equal(safeName('..'), 'file')
    assert.equal(safeName('보고서.pdf'), '보고서.pdf')
  })
})

describe('page', () => {
  // The view's module is appended by an inline loader at the end of <body>; without it
  // neither view runs and nothing reports an error (it slipped once).
  const html = readFileSync(resolve('web/index.html'), 'utf8')
  it('loads one module per view, after the markup', () => {
    const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'))
    const loader = body.lastIndexOf("'./main.js?v=__V__'")
    assert.ok(loader > body.indexOf('<section id="setup"'), 'the loader comes after the setup section')
    assert.ok(body.includes("'./setup.js?v=__V__'"), 'the setup module is named')
    assert.ok(!html.includes('<script type="module"'), 'no static module tag, the loader picks one')
  })
  it('decides the view before paint', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    assert.ok(head.includes("dataset.view ="), 'data-view is set in the head')
    assert.ok(head.includes("get('receiver') === '1'"), '?receiver=1 forces the receiver')
  })
})

describe('URL options', () => {
  it('?scan= is an integer clamped to [64, video width]', () => {
    assert.equal(scanWidth(null, 1920), 1920)
    assert.equal(scanWidth(null, 3840), 1920)
    assert.equal(scanWidth('1280', 1920), 1280)
    assert.equal(scanWidth('-1', 1920), 64)
    assert.equal(scanWidth('99999', 1920), 1920)
    assert.equal(scanWidth('640.9', 1920), 640)
    assert.equal(scanWidth('abc', 1280), 1280)
    assert.equal(scanWidth('', 1280), 1280)
  })

  it('?max= is MiB clamped to [1, 512], default 64', () => {
    assert.equal(limitMib(null), 64)
    assert.equal(limitMib('128'), 128)
    assert.equal(limitMib('0'), 1)
    assert.equal(limitMib('-5'), 1)
    assert.equal(limitMib('1e9'), 512)
    assert.equal(limitMib('x'), 64)
  })

  it('names sizes in the too-large message', () => {
    assert.equal(tooLargeText(1_377_000_000, 64 * 2 ** 20), 'File too large: 1,313 MiB > limit 64 MiB (change it with ?max=)')
  })
})

describe('resume store', () => {
  const exp = (n: number) => {
    const b = new ArrayBuffer(8 + 108 * n)
    new Uint8Array(b).set([79, 67, 83, 49])
    new DataView(b).setUint32(4, n)
    return b
  }

  it('recognises well-formed exports only', () => {
    assert.equal(exportTiles(exp(3)), 3)
    assert.equal(exportTiles(exp(0)), 0)
    assert.equal(exportTiles(exp(3).slice(0, 100)), -1)
    assert.equal(exportTiles(new ArrayBuffer(4)), -1)
    assert.equal(exportTiles('OCS1'), -1)
    assert.equal(exportTiles(undefined), -1)
  })

  it('evicts entries older than 7 days and beyond 128 MiB, newest kept first', () => {
    const day = 24 * 3600 * 1000
    const now = 100 * day
    const e = (id: string, ageDays: number, mib: number): SavedMeta => ({ id, name: id, size: 0, savedAt: now - ageDays * day, tiles: 1, bytes: mib * 2 ** 20 })
    assert.deepEqual(evictable([e('a', 1, 10), e('b', 8, 1), e('c', 2, 10)], now, null), ['b'])
    assert.deepEqual(evictable([e('new', 0, 100), e('mid', 1, 20), e('old', 2, 20)], now, null), ['old'])
    // The entry being saved is never evicted, but counts towards the budget.
    assert.deepEqual(evictable([e('keep', 9, 120), e('x', 0, 20)], now, 'keep'), ['x'])
  })
})

describe('wasm wrapper', () => {
  it('a failed alloc skips the frame and never writes to address 0', () => {
    const memory = new WebAssembly.Memory({ initial: 4 })
    const writes: number[] = []
    let allow = true
    const fake = Object.create(WasmReceiver.prototype) as WasmReceiver
    Object.assign(fake, {
      ex: {
        memory,
        alloc: () => (allow ? 1024 : 0),
        dealloc: () => {},
        receiver_process: (_h: number, ptr: number) => (writes.push(ptr), -1),
        receiver_import: (_h: number, ptr: number) => (writes.push(ptr), 0),
      },
      handle: 1,
      buffer: 0,
      capacity: 0,
    })
    assert.equal(fake.process(new Uint8Array(100), 5, 5), -1)
    allow = false
    new Uint8Array(memory.buffer).fill(0xee, 0, 16)
    assert.equal(fake.process(new Uint8Array(200).fill(7), 5, 10), OUT_OF_MEMORY)
    assert.equal(fake.process(new Uint8Array(200).fill(7), 5, 10), OUT_OF_MEMORY)
    assert.equal(fake.importState(new Uint8Array(300)), -1)
    assert.deepEqual(writes, [1024])
    assert.deepEqual([...new Uint8Array(memory.buffer, 0, 4)], [0xee, 0xee, 0xee, 0xee])
    allow = true
    assert.equal(fake.process(new Uint8Array(200), 5, 10), -1)
    assert.deepEqual(writes, [1024, 1024])
  })
})

const WASM = resolve('web/diodecam.wasm')
/** The newest built `diodecam` binary that has the hidden `frames` command. */
function senderBinary(): string | null {
  const built = ['target/release/diodecam', 'target/debug/diodecam']
    .map((p) => resolve(p))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return built.find((p) => spawnSync(p, ['frames', '--help']).status === 0) ?? null
}
const BIN = senderBinary()
const skip = !existsSync(WASM) ? 'web/diodecam.wasm missing: run `pnpm wasm`' : !BIN ? 'diodecam binary missing: run `cargo build -p diodecam-cli`' : false

describe('wasm receiver', { skip }, () => {
  it('restores a file from simulated camera frames, ignoring torn ones', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diodecam-'))
    try {
      const original = randomBytes(6000, 21)
      writeFileSync(join(dir, 'data.bin'), original)
      const out = join(dir, 'frames.jsonl')
      const run = spawnSync(BIN!, ['frames', join(dir, 'data.bin'), '--cols', '120', '--rows', '40', '--count', '16', '--skip', '3', '--out', out])
      assert.equal(run.status, 0, run.stderr.toString())
      const [header, ...lines] = readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      assert.equal(header.width, 119)

      const rx = await WasmReceiver.create(readFileSync(WASM))
      assert.equal(rx.stats().stage, null)
      assert.equal(rx.process(new Uint8Array(320 * 240 * 4), 320, 240), -1)
      assert.equal(rx.stats().stage, 'finders') // the stage a frame without a grid stopped at
      const vt = new VTerm({ cols: 120, rows: 40 })
      const camera = { width: 1280, height: 720 }
      let previous: ReturnType<VTerm['rasterize']> | null = null
      let file: Uint8Array | null = null
      let passed = 0
      for (const [i, line] of lines.entries()) {
        vt.write(line.ansi)
        const screen = vt.rasterize({ lineGap: 2 })
        const corners = framing(camera.width, camera.height, screen.width / screen.height, 0.85, 0.04)
        // Every third capture is torn: the top half already shows the next frame.
        let shown = screen
        if (previous && i % 3 === 0) {
          shown = { ...previous, data: previous.data.slice() }
          shown.data.set(screen.data.subarray(0, (screen.height >> 1) * screen.width))
        }
        previous = screen
        const shot = cameraView(shown, { ...camera, corners, blur: 1, noise: 6, levels: [30, 220], seed: i + 1 })
        const ok = rx.process(toRgba(shot), shot.width, shot.height)
        const stats = rx.stats()
        assert.ok(ok >= 0, `frame ${i}: ${ok}`)
        assert.deepEqual(stats.grid, { w: 119, h: 76, profile: 'ssh' })
        assert.equal(stats.stage, 'done')
        const module = moduleSize(stats.corners, stats.grid)
        assert.ok(module !== null && module > 7 && module < 10, `module ${module} px`) // 0.85 × 1280 px over 119 modules, tilted
        passed += ok
        if (stats.done) {
          assert.equal(stats.meta?.name, 'data.bin')
          assert.equal(stats.meta?.size, original.length)
          file = rx.file()
          break
        }
      }
      assert.ok(passed > 0)
      assert.ok(file, 'no file restored')
      assert.ok(Buffer.from(file).equals(Buffer.from(original)), 'restored file differs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
