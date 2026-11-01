// Receiver v2 (web/): the screen's rolling metrics, and the WebAssembly receiver
// fed with real sender frames through the TS terminal and camera simulators.
// The wasm test needs `pnpm wasm:build` and a built `opticast` binary; it is
// skipped (with a note) when they are missing.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cameraView, framing, toRgba } from '../tools/sim/camera.ts'
import { VTerm } from '../tools/sim/vterm.ts'
import {
  eta,
  formatBytes,
  fps,
  hint,
  limitMib,
  recognition,
  safeName,
  scanWidth,
  symbolRate,
  tooLargeText,
  trim,
  type FrameSample,
} from '../web/metrics.ts'
import { evictable, exportTiles, type SavedMeta } from '../web/store.ts'
import { OUT_OF_MEMORY, WasmReceiver } from '../web/wasm.ts'
import { randomBytes } from './helpers.ts'

const frame = (t: number, tilesOk: number, tiles = 10, grid = true): FrameSample => ({ t, grid, tilesOk, tiles })

describe('receiver v2 metrics', () => {
  it('keeps only the recent window', () => {
    const s = [0, 500, 1000, 2600, 3000].map((t) => frame(t, 1))
    expect(trim(s, 2000).map((f) => f.t)).toEqual([1000, 2600, 3000])
    expect(trim([], 2000)).toEqual([])
  })

  it('recognition is tiles passed over tiles tried', () => {
    expect(recognition([frame(0, 9), frame(1, 10)])).toBeCloseTo(0.95)
    expect(recognition([frame(0, 0, 0, false)])).toBeNull()
  })

  it('hints follow the 90 % / 70 % thresholds and the no-grid case', () => {
    expect(hint([frame(0, 9), frame(1, 10)])).toBe('faster')
    expect(hint([frame(0, 8), frame(1, 8)])).toBeNull()
    expect(hint([frame(0, 6), frame(1, 7)])).toBe('slower')
    expect(hint([frame(0, 0, 0, false), frame(1, 0, 0, false)])).toBe('aim')
    expect(hint([])).toBeNull()
  })

  it('ETA uses the recent symbol rate', () => {
    const rate = symbolRate([
      { t: 0, have: 100 },
      { t: 5000, have: 1100 },
    ])
    expect(rate).toBe(200)
    expect(eta(1100, 3100, rate)).toBe(10)
    expect(eta(3200, 3100, rate)).toBe(0)
    expect(eta(10, 100, 0)).toBeNull()
    expect(symbolRate([{ t: 0, have: 1 }])).toBeNull()
  })

  it('fps from callback times', () => {
    expect(fps([0, 33.3, 66.6, 100, 133.3, 166.6, 200, 233.3, 266.6, 300, 333.3])).toBeCloseTo(30, 0)
    expect(fps([0])).toBeNull()
  })

  it('formats sizes in SI units like the sender', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1_000_000)).toBe('1.00 MB')
    expect(formatBytes(41_500)).toBe('41.5 KB')
  })

  it('file names are made safe for display and download', () => {
    expect(safeName('../x')).toBe('.._x')
    expect(safeName('a/b\\c')).toBe('a_b_c')
    expect(safeName('evil‮fdp.exe')).toBe('evil_fdp.exe')
    expect(safeName('a\u0007b\u001bc')).toBe('a_b_c')
    expect(safeName('')).toBe('file')
    expect(safeName('..')).toBe('file')
    expect(safeName('보고서.pdf')).toBe('보고서.pdf')
  })
})

describe('receiver v2 URL options', () => {
  it('?scan= is an integer clamped to [64, video width]', () => {
    expect(scanWidth(null, 1920)).toBe(1920)
    expect(scanWidth(null, 3840)).toBe(1920)
    expect(scanWidth('1280', 1920)).toBe(1280)
    expect(scanWidth('-1', 1920)).toBe(64)
    expect(scanWidth('99999', 1920)).toBe(1920)
    expect(scanWidth('640.9', 1920)).toBe(640)
    expect(scanWidth('abc', 1280)).toBe(1280)
    expect(scanWidth('', 1280)).toBe(1280)
  })

  it('?max= is MiB clamped to [1, 512], default 64', () => {
    expect(limitMib(null)).toBe(64)
    expect(limitMib('128')).toBe(128)
    expect(limitMib('0')).toBe(1)
    expect(limitMib('-5')).toBe(1)
    expect(limitMib('1e9')).toBe(512)
    expect(limitMib('x')).toBe(64)
  })

  it('names sizes in the too-large message', () => {
    expect(tooLargeText(1_377_000_000, 64 * 2 ** 20)).toBe('파일이 너무 큽니다: 1,313 MiB > 한도 64 MiB (?max= 로 바꿀 수 있습니다)')
  })
})

describe('receiver v2 resume store', () => {
  const exp = (n: number) => {
    const b = new ArrayBuffer(8 + 108 * n)
    new Uint8Array(b).set([79, 67, 83, 49])
    new DataView(b).setUint32(4, n)
    return b
  }

  it('recognises well-formed exports only', () => {
    expect(exportTiles(exp(3))).toBe(3)
    expect(exportTiles(exp(0))).toBe(0)
    expect(exportTiles(exp(3).slice(0, 100))).toBe(-1)
    expect(exportTiles(new ArrayBuffer(4))).toBe(-1)
    expect(exportTiles('OCS1')).toBe(-1)
    expect(exportTiles(undefined)).toBe(-1)
  })

  it('evicts entries older than 7 days and beyond 128 MiB, newest kept first', () => {
    const day = 24 * 3600 * 1000
    const now = 100 * day
    const e = (id: string, ageDays: number, mib: number): SavedMeta => ({ id, name: id, size: 0, savedAt: now - ageDays * day, tiles: 1, bytes: mib * 2 ** 20 })
    expect(evictable([e('a', 1, 10), e('b', 8, 1), e('c', 2, 10)], now, null)).toEqual(['b'])
    expect(evictable([e('new', 0, 100), e('mid', 1, 20), e('old', 2, 20)], now, null)).toEqual(['old'])
    // The entry being saved is never evicted, but counts towards the budget.
    expect(evictable([e('keep', 9, 120), e('x', 0, 20)], now, 'keep')).toEqual(['x'])
  })
})

describe('receiver v2 wasm wrapper', () => {
  it('a failed alloc skips the frame and never writes to address 0 (review M2)', () => {
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
    expect(fake.process(new Uint8Array(100), 5, 5)).toBe(-1)
    allow = false
    new Uint8Array(memory.buffer).fill(0xee, 0, 16)
    expect(fake.process(new Uint8Array(200).fill(7), 5, 10)).toBe(OUT_OF_MEMORY)
    expect(fake.process(new Uint8Array(200).fill(7), 5, 10)).toBe(OUT_OF_MEMORY)
    expect(fake.importState(new Uint8Array(300))).toBe(-1)
    expect(writes).toEqual([1024])
    expect([...new Uint8Array(memory.buffer, 0, 4)]).toEqual([0xee, 0xee, 0xee, 0xee])
    allow = true
    expect(fake.process(new Uint8Array(200), 5, 10)).toBe(-1)
    expect(writes).toEqual([1024, 1024])
  })
})

const WASM = resolve('web/wasm/opticast.wasm')
/** The newest built `opticast` binary that has the hidden `frames` command. */
function senderBinary(): string | null {
  const built = ['target/release/opticast', 'target/debug/opticast']
    .map((p) => resolve(p))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return built.find((p) => spawnSync(p, ['frames', '--help']).status === 0) ?? null
}
const BIN = senderBinary()
const ready = existsSync(WASM) && BIN !== null
if (!ready) console.warn('receiver-v2 wasm test skipped: run `pnpm wasm:build` and `cargo build -p opticast-cli`')

describe.skipIf(!ready)('receiver v2 wasm', () => {
  it('restores a file from simulated camera frames, ignoring torn ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opticast-v2-'))
    try {
      const original = randomBytes(6000, 21)
      writeFileSync(join(dir, 'data.bin'), original)
      const out = join(dir, 'frames.jsonl')
      const run = spawnSync(BIN!, ['frames', join(dir, 'data.bin'), '--cols', '120', '--rows', '40', '--count', '16', '--skip', '3', '--out', out])
      expect(run.status, run.stderr.toString()).toBe(0)
      const [header, ...lines] = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(header.width).toBe(119)

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
        expect(ok, `frame ${i}`).toBeGreaterThanOrEqual(0)
        expect(stats.grid).toEqual({ w: 119, h: 76, profile: 'ssh' })
        passed += ok
        if (stats.done) {
          expect(stats.meta?.name).toBe('data.bin')
          expect(stats.meta?.size).toBe(original.length)
          file = rx.file()
          break
        }
      }
      expect(passed).toBeGreaterThan(0)
      expect(file).not.toBeNull()
      expect(Buffer.from(file!).equals(Buffer.from(original))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
