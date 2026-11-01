// The receiver (web/): the screen's rolling metrics, the resume store's pure
// rules, and the WebAssembly receiver fed with real sender frames through the
// terminal and camera simulators. The wasm test needs `pnpm wasm` and a built
// `opticast` binary; it is skipped (with a note) when they are missing.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { cameraView, framing, toRgba } from '../tools/sim/camera.ts'
import { VTerm } from '../tools/sim/vterm.ts'
import { eta, formatBytes, fps, hint, limitMib, recognition, safeName, scanWidth, symbolRate, tooLargeText, trim, type FrameSample } from '../web/metrics.js'
import { evictable, exportTiles, type SavedMeta } from '../web/store.js'
import { OUT_OF_MEMORY, WasmReceiver } from '../web/wasm.js'
import { randomBytes } from './helpers.ts'

const frame = (t: number, tilesOk: number, tiles = 10, grid = true): FrameSample => ({ t, grid, tilesOk, tiles })
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
    assert.equal(tooLargeText(1_377_000_000, 64 * 2 ** 20), '파일이 너무 큽니다: 1,313 MiB > 한도 64 MiB (?max= 로 바꿀 수 있습니다)')
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

const WASM = resolve('web/opticast.wasm')
/** The newest built `opticast` binary that has the hidden `frames` command. */
function senderBinary(): string | null {
  const built = ['target/release/opticast', 'target/debug/opticast']
    .map((p) => resolve(p))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return built.find((p) => spawnSync(p, ['frames', '--help']).status === 0) ?? null
}
const BIN = senderBinary()
const skip = !existsSync(WASM) ? 'web/opticast.wasm missing: run `pnpm wasm`' : !BIN ? 'opticast binary missing: run `cargo build -p opticast-cli`' : false

describe('wasm receiver', { skip }, () => {
  it('restores a file from simulated camera frames, ignoring torn ones', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opticast-'))
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
