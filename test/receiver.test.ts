// The receiver (web/): the screen's rolling metrics, the resume store's pure
// rules, and the WebAssembly receiver fed with real sender frames through the
// terminal and camera simulators. The wasm test needs `pnpm wasm` and a built
// `diodecam` binary; locally it is skipped (with a note) when they are missing, in CI it fails.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { cameraView, framing, tear, toRgba } from '../tools/sim/camera.ts'
import { randomBytes, senderFrames } from '../tools/sim/sender.ts'
import { VTerm } from '../tools/sim/vterm.ts'
import { MIN_MODULE_PX, captureWidth, eta, failure, formatBytes, formatSeconds, fps, hint, limitMib, moduleSize, quantile, recognition, safeName, scanWidth, symbolRate, tooLargeText, trim, type FrameSample, type Stage } from '../web/metrics.js'
import { evictable, exportTiles, keepable, shouldSave, type KeptFile, type SavedMeta } from '../web/store.js'
import { diagnostics, view, type View, type ViewState } from '../web/view.js'
import { OUT_OF_MEMORY, WasmReceiver, type ReceiverStats } from '../web/wasm.js'

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
    assert.equal(formatSeconds(119.5), '2 min 0 s')
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

describe('view', () => {
  const meta = { name: 'a.bin', size: 10, id: 'abcd1234', compression: 'none' }
  const stats = (have: number, need: number | null, done = false): ViewState['stats'] => ({ meta, done, symbols: { have, need }, too_large: null, limit: 64 * 2 ** 20 })
  const offer = (canShare = true): ViewState['offer'] => ({ saved: false, restored: false, at: 0, canShare })
  const state = (over: Partial<ViewState> = {}): ViewState => ({
    scanning: false,
    starting: false,
    fatal: '',
    notice: null,
    offer: null,
    stats: null,
    resumed: 0,
    workerError: '',
    rate: null,
    left: null,
    hint: null,
    gridSeen: false,
    ...over,
  })
  const enabled = (v: View) =>
    Object.entries(v.buttons)
      .filter(([, b]) => b.enabled)
      .map(([k]) => k)
  const primary = (v: View) =>
    Object.entries(v.buttons)
      .filter(([, b]) => 'primary' in b && b.primary)
      .map(([k]) => k)

  it('follows the interaction-state table (DESIGN.md)', () => {
    // [state, strip, enabled buttons, primary buttons, ring, tick]
    const table: [string, ViewState, View['strip']['state'], string[], string[], boolean, boolean][] = [
      ['idle', state(), 'idle', ['start'], ['start'], false, false],
      ['looking', state({ scanning: true }), 'idle', ['start', 'reset'], [], false, false],
      ['receiving', state({ scanning: true, stats: stats(40, 100) }), 'receiving', ['start', 'reset'], [], true, false],
      ['paused', state({ stats: stats(40, 100) }), 'idle', ['start', 'reset'], ['start'], false, false],
      ['done, share sheet', state({ offer: offer(), stats: stats(100, 100, true) }), 'done', ['start', 'download', 'share', 'reset'], ['share'], false, true],
      ['done, download only', state({ offer: offer(false) }), 'done', ['start', 'download', 'reset'], ['download'], false, true],
      ['error', state({ notice: { text: 'No camera found on this device.', tone: 'bad' } }), 'error', ['start', 'reset'], [], false, false],
      ['error, kept file', state({ notice: { text: 'x', tone: 'bad' }, offer: offer() }), 'error', ['start', 'download', 'share', 'reset'], ['share'], false, false],
      ['opening the camera', state({ starting: true }), 'idle', [], ['start'], false, false],
      ['decoder gone', state({ fatal: 'Decoder error.', stats: stats(40, 100) }), 'error', ['reset'], [], false, false],
    ]
    for (const [name, s, strip, on, primaries, ring, tick] of table) {
      const v = view(s)
      assert.equal(v.strip.state, strip, `${name}: strip`)
      assert.deepEqual(enabled(v), on, `${name}: enabled buttons`)
      assert.deepEqual(primary(v), primaries, `${name}: primary buttons`)
      assert.equal(v.ring, ring, `${name}: ring`)
      assert.equal(v.tick, tick, `${name}: tick`)
      assert.equal(v.prompt, !tick, `${name}: prompt`)
    }
  })

  it('words the strip, hint and status for the state', () => {
    const receiving = view(state({ scanning: true, stats: stats(1234, 5000), rate: 0.875, left: 75, resumed: 300 }))
    assert.deepEqual(receiving.strip, { state: 'receiving', label: '● Receiving', symbols: '1,234 / 5,000', extra: '88% read · 300 resumed', right: '1 min 15 s left' })
    assert.equal(receiving.status.text, '3,766 pieces to go · about 1 min 15 s')
    assert.equal(view(state({ scanning: true, stats: stats(1, 5), hint: 'rotate' })).hint.text, '⚠ Hold the phone sideways for a larger grid')
    assert.equal(view(state({ scanning: true, gridSeen: true })).status.text, 'Grid found. Waiting for the file header…')
    assert.equal(view(state({ offer: offer() })).hint.text, 'Save it, then press q in the terminal')
    const error = view(state({ notice: { text: 'No camera found on this device.', tone: 'bad' } }))
    assert.equal(error.strip.extra, 'No camera found on this device.')
    assert.deepEqual(error.status, { text: 'No camera found on this device.', tone: 'bad' })
    // A warning (a failed share, a failed restore) is not an error.
    assert.equal(view(state({ scanning: true, stats: stats(1, 5), notice: { text: 'w', tone: 'warn' } })).strip.state, 'receiving')
    assert.equal(view(state({ stats: stats(50, 100) })).fraction, 0.5)
    assert.equal(view(state({ offer: offer(), stats: stats(50, 100) })).fraction, 1, 'a kept file fills the bar')
  })

  it('diagnostics never carry the file name, size, content, transfer id or device ids', () => {
    const name = 'quarterly-secret-report.pdf'
    const size = 987_654_321
    const id = 'c0ffee42'
    const content = new TextEncoder().encode('TOP-SECRET-CONTENT')
    const devices = { deviceId: 'device-5a1b2c3d', groupId: 'group-9e8f7a6b' }
    const decoder: ReceiverStats = {
      frames: 90,
      detected: true,
      stage: 'done',
      grid: { w: 119, h: 76, profile: 'ssh' },
      corners: [10, 10, 410, 10, 410, 310, 10, 310],
      tiles: { ok: 9, total: 10 },
      totals: { frames: 90, detections: 80, tiles_ok: 700, tiles: 800 },
      symbols: { have: 400, need: 1000 },
      meta: { name, size, id, compression: 'zstd' },
      limit: 64 * 2 ** 20,
      too_large: { id, size },
      too_large_count: 1,
      foreign: 0,
      duplicates: 3,
      invalid: 0,
      failed: 0,
      done: false,
      error: null,
      kept: 400,
      tile_status: '1111111110',
    }
    const snapshot = {
      app: 'DiodeCam test',
      at: '2026-11-02T00:00:00.000Z',
      now: 10_000,
      agent: 'test agent',
      standalone: false,
      viewport: '390×844 @3x',
      lens: 'Back Camera',
      manualCamera: true,
      video: { width: 1920, height: 1080 },
      scan: { width: 1920, height: 1080 },
      settings: { ...devices, width: 1920, height: 1080, frameRate: 30 },
      capabilities: { ...devices, width: { min: 1, max: 4032 } },
      session: { started: 0, frames: 90, stages: { done: 80, finders: 10 }, detections: 80, tracked: 70, corrected: 5, modules: [7.5, 7.7], residuals: [0.05] },
      scanning: true,
      frames: [frame(9000, 9), frame(9500, 8)],
      captureTimes: [9000, 9033, 9066, 9100, 9133, 9166, 9200, 9233, 9266, 9300, 9333],
      resultTimes: [9000, 9500],
      decodeMs: 12.34,
      stats: decoder,
      // More of what the page holds; a snapshot never has it, and it would not be copied if it did.
      file: content,
      offer: { name, size, id },
    }
    const copied = diagnostics(snapshot)
    const json = JSON.stringify(copied)
    const secrets = [name, String(size), size.toLocaleString('en-US'), formatBytes(size), id, new TextDecoder().decode(content), JSON.stringify(content).slice(0, 30), devices.deviceId, devices.groupId]
    for (const secret of secrets) assert.ok(!json.includes(secret), `the diagnostics contain ${secret}`)
    // Not vacuous: the camera and recognition numbers are there.
    assert.equal(copied.camera.lens, 'Back Camera')
    assert.deepEqual(copied.camera.settings, { width: 1920, height: 1080, frameRate: 30 })
    assert.deepEqual(copied.transfer, { progress: 0.4, foreign: 0, invalid: 0, failed: 0, done: false })
    assert.deepEqual(copied.grid, { w: 119, h: 76, profile: 'ssh' })
    assert.equal(copied.recent.capture_fps, 30)
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
  it('has one setup section with four steps', () => {
    // A section rewrite once left the old tail behind, doubling the page.
    assert.equal((html.match(/<section id="setup"/g) ?? []).length, 1)
    assert.equal((html.match(/class="step"/g) ?? []).length, 4)
    assert.equal((html.match(/class="setup-foot"/g) ?? []).length, 1)
    assert.ok(!html.includes('send report.pdf'), 'commands use <FILE>, not a sample name')
    assert.ok(html.includes('<span>v__VERSION__</span>'), 'the footer version is injected from Cargo.toml by the deploy')
    assert.ok(!/\bv\d+\.\d+\.\d+\b/.test(html), 'no hand-written version in the page')
  })
  it('quotes the file argument the way the shell needs', async () => {
    // setup.js is a browser module; the rule is small enough to mirror here and keep in sync.
    const src = readFileSync(resolve('web/setup.js'), 'utf8')
    const fn = src.slice(src.indexOf('const fileArg = () => {'), src.indexOf('/** @param {string} target */'))
    // fileArg is self-contained apart from `fileInput`
    const fileArg = new Function('fileInput', `${fn} return fileArg()`) as (i: { value: string }) => string
    assert.equal(fileArg({ value: '' }), '<FILE>')
    assert.equal(fileArg({ value: 'report.pdf' }), 'report.pdf')
    assert.equal(fileArg({ value: 'my report (final).pdf' }), "'my report (final).pdf'")
    assert.equal(fileArg({ value: "it's.txt" }), "'it'\\''s.txt'")
    assert.equal(fileArg({ value: '~/docs/a.tgz' }), '~/docs/a.tgz')
    assert.equal(fileArg({ value: '~/my docs/a.tgz' }), "~/'my docs/a.tgz'")
    assert.equal(fileArg({ value: '-V' }), './-V')
    assert.equal(fileArg({ value: 'help' }), './help')
    assert.equal(fileArg({ value: '=x.bin' }), "'./=x.bin'") // ./ defeats zsh's `=cmd` expansion; quoted since = is not in the plain set
  })
  it('decides the view before paint', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    assert.ok(head.includes("dataset.view ="), 'data-view is set in the head')
    assert.ok(head.includes("get('receiver') === '1'"), '?receiver=1 forces the receiver')
  })
  it('has every element the scripts look up by id', () => {
    const ids = new Set([...html.matchAll(/(?<![\w-])id="([^"]+)"/g)].map((m) => m[1]))
    // main.js wraps getElementById as `$('x')`, setup.js as `set('x', …)`.
    const lookups = ['main.js', 'setup.js'].flatMap((f) =>
      [...readFileSync(resolve('web', f), 'utf8').matchAll(/(?:getElementById|(?<![\w.])\$|(?<![\w.])set)\('([^']+)'/g)].map((m) => m[1] ?? ''),
    )
    for (const known of ['preview', 'cmd-run', 'theme-btn']) assert.ok(lookups.includes(known), `the pattern finds ${known}`)
    // The copy buttons look up their data-copy target.
    const copies = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1] ?? '')
    for (const id of [...lookups, ...copies]) assert.ok(ids.has(id), `#${id} is looked up but not in index.html`)
  })
  it('caches only files that exist for the offline copy', () => {
    const sw = readFileSync(resolve('web/sw.js'), 'utf8')
    const list = sw.slice(sw.indexOf('const FILES = ['), sw.indexOf('].map('))
    const files = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
    assert.ok(files.includes('main.js') && files.includes('diodecam.wasm'), 'the FILES list is found')
    for (const f of files) {
      if (f === 'diodecam.wasm' && !existsSync(resolve('web', f))) continue // built by `pnpm wasm`
      assert.ok(existsSync(resolve('web', f)), `sw.js caches ${f}, which is not in web/`)
    }
    // And the other way: every versioned reference in the page files is cached.
    const referenced = new Set<string>()
    for (const f of readdirSync(resolve('web')).filter((f) => /\.(html|js|css|webmanifest)$/.test(f)))
      for (const m of readFileSync(resolve('web', f), 'utf8').matchAll(/\.\/([\w.-]+)\?v=__V__/g)) referenced.add(m[1] ?? '')
    for (const f of referenced) assert.ok(files.includes(f), `${f} is referenced with ?v= but sw.js does not cache it`)
  })
  it('redefines every colour token for dark mode, the same way in both dark blocks', () => {
    const css = readFileSync(resolve('web/style.css'), 'utf8')
    const tokens = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      assert.ok(start >= 0, `${selector} is in style.css`)
      const body = css.slice(start, css.indexOf('}', start))
      return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m): [string, string] => [m[1] ?? '', (m[2] ?? '').trim()]))
    }
    const light = tokens(':root')
    const system = tokens(":root:not([data-theme='light'])")
    const chosen = tokens(":root[data-theme='dark']")
    assert.deepEqual(chosen, system, 'a chosen dark theme is the system dark theme')
    for (const t of system.keys()) assert.ok(light.has(t), `${t} is defined for dark mode only`)
    // Not tied to a mode: the one signal hue, the always-dark camera box, a length, a font stack.
    const shared = [...light.keys()].filter((t) => !system.has(t)).sort()
    assert.deepEqual(shared, ['--camera', '--gutter', '--mono', '--signal'], 'a new light token needs a dark value')
  })
  it('the doc pages share one theme script, keyed like the setup page', () => {
    const key = /THEME_KEY = '([^']+)'/.exec(readFileSync(resolve('web/setup.js'), 'utf8'))?.[1]
    assert.ok(key, 'THEME_KEY is in setup.js')
    const scripts = ['help', 'privacy', 'terms', 'licenses'].map((p) => {
      const page = readFileSync(resolve(`web/${p}.html`), 'utf8')
      assert.ok(page.includes('<script>'), `${p}.html has its theme script`)
      return page.slice(page.indexOf('<script>'), page.indexOf('</script>'))
    })
    for (const s of scripts) assert.equal(s, scripts[0])
    assert.ok(scripts[0]?.includes(`localStorage.getItem('${key}')`), 'the doc pages read the key setup.js writes')
    assert.ok(html.includes(`localStorage.getItem('${key}')`), 'so does index.html')
  })
})

describe('URL options', () => {
  it('?scan= is an integer clamped to [64, video width]', () => {
    assert.equal(scanWidth(null, 1920), 1920)
    assert.equal(scanWidth(null, 3840), 1920)
    assert.equal(scanWidth('1280', 1920), 1280)
    assert.equal(scanWidth('-1', 1920), 64)
    assert.equal(captureWidth(null), 1920)
    assert.equal(captureWidth('3840'), 3840)
    assert.equal(captureWidth('9999'), 3840)
    assert.equal(captureWidth('x'), 1920)
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

  it('never replaces a saved entry with one of fewer tiles', () => {
    const saved: SavedMeta = { id: 'a', name: 'a', size: 1, savedAt: 0, tiles: 50, bytes: 8 + 50 * 108 }
    assert.equal(shouldSave(undefined, 1), true)
    assert.equal(shouldSave(saved, 49), false)
    assert.equal(shouldSave(saved, 50), true, 'the same count is saved again (fresh savedAt)')
    assert.equal(shouldSave(saved, 51), true)
  })

  it('offers the received file for 24 hours at most (the privacy.html promise)', () => {
    const day = 24 * 3600 * 1000
    const now = 100 * day
    const kept = (ageMs: number, blob: unknown = new Blob(['x'])) => ({ id: 'a', name: 'a', size: 1, receivedAt: now - ageMs, blob }) as KeptFile
    assert.equal(keepable(kept(0), now), true)
    assert.equal(keepable(kept(day), now), true)
    assert.equal(keepable(kept(day + 1), now), false)
    assert.equal(keepable(kept(0, null), now), false, 'its stored bytes are gone')
    assert.equal(keepable(kept(0, {}), now), false)
    assert.equal(keepable(undefined, now), false)
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
// Locally a missing build skips the suite with a note; in CI it must run, so a missing build fails.
const skip = process.env.CI ? false : !existsSync(WASM) ? 'web/diodecam.wasm missing: run `pnpm wasm`' : !BIN ? 'diodecam binary missing: run `cargo build -p diodecam-cli`' : false

describe('wasm receiver', { skip }, () => {
  it('restores a file from simulated camera frames, ignoring torn ones', { timeout: 60_000 }, async () => {
    const original = randomBytes(6000, 21)
    const { header, frames } = senderFrames({ bytes: original, name: 'data.bin', cols: 120, rows: 40, count: 16, skip: 3 }, BIN!)
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
    for (const [i, ansi] of frames.entries()) {
      vt.write(ansi)
      const screen = vt.rasterize({ lineGap: 2 })
      const corners = framing(camera.width, camera.height, screen.width / screen.height, 0.85, 0.04)
      // Every third capture is torn: the top half already shows the next frame.
      const shown = previous && i % 3 === 0 ? tear(screen, previous, screen.height >> 1) : screen
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
  })
})

describe('simulator', () => {
  it('a torn capture takes the top rows from the newer frame', () => {
    const gray = (fill: number) => ({ width: 2, height: 3, data: new Uint8Array(6).fill(fill) })
    assert.deepEqual([...tear(gray(1), gray(2), 1).data], [1, 1, 2, 2, 2, 2])
    assert.deepEqual([...tear(gray(1), gray(2), 9).data], [1, 1, 1, 1, 1, 1])
  })
})
