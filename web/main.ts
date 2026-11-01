// OptiCast receiver v2 (docs/receiver-v2.md): camera → requestVideoFrameCallback
// → canvas → decoder worker (WebAssembly) → progress, verified file, save/share.
// Everything stays in this browser; nothing is uploaded.

import {
  HINT_TEXT,
  eta,
  formatBytes,
  formatSeconds,
  fps,
  hint,
  limitMib,
  recognition,
  safeName,
  scanWidth,
  symbolRate,
  thousands,
  tooLargeText,
  trim,
  type FrameSample,
  type ProgressSample,
} from './metrics.ts'
import type { FromWorker, ToWorker } from './protocol.ts'
import { store } from './store.ts'
import type { ReceiverStats } from './wasm.ts'

const params = new URLSearchParams(location.search)
/** `?scan=`: width of the image handed to the decoder (see scanWidth). */
const SCAN_PARAM = params.get('scan')
/** `?max=`: largest file accepted, in MiB. */
const LIMIT_MIB = limitMib(params.get('max'))
const DEBUG = params.get('debug') === '1'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('preview')
const overlay = $<HTMLCanvasElement>('overlay')
const statusEl = $('status')
const startBtn = $<HTMLButtonElement>('start')
const resetBtn = $<HTMLButtonElement>('reset')
const fileNameEl = $('file-name')
const fileSizeEl = $('file-size')
const fileIdEl = $('file-id')
const symbolsEl = $('symbols')
const percentEl = $('percent')
const progressEl = $<HTMLProgressElement>('progress')
const hintEl = $('hint')
const resultEl = $('result')
const resultText = $('result-text')
const downloadBtn = $<HTMLButtonElement>('download')
const shareBtn = $<HTMLButtonElement>('share')
const debugEl = $('debug')
const stat = {
  capture: $('stat-capture'),
  process: $('stat-process'),
  ms: $('stat-ms'),
  recognition: $('stat-recognition'),
  grid: $('stat-grid'),
  camera: $('stat-camera'),
  foreign: $('stat-foreign'),
  eta: $('stat-eta'),
}

const scanCanvas = document.createElement('canvas')
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true })!
const overlayCtx = overlay.getContext('2d')!

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer)
send({ type: 'limit', mib: LIMIT_MIB })
if (DEBUG) {
  send({ type: 'debug', on: true })
  debugEl.hidden = false
  // Test hook: make the decoder take its trap-recovery path.
  Object.assign(window, { opticastDebug: { trap: () => send({ type: 'simulate-trap' }) } })
}

let stream: MediaStream | null = null
let scanning = false
let starting = false
let busy = false
let seq = 0
/** Bumped by stopCamera(): frame callbacks of an earlier start chain exit. */
let loopGen = 0
let frameHandle: { rvfc: boolean; id: number } | null = null
/** Bumped by reset(): results of IndexedDB reads that started before it are dropped. */
let resetGen = 0
let settings: MediaTrackSettings = {}
let last: ReceiverStats | null = null
let decodeMs = 0
let frames: FrameSample[] = []
let progress: ProgressSample[] = []
let captureTimes: number[] = []
let resultTimes: number[] = []
let workerError = ''
let download: { url: string; name: string; file: File } | null = null
/** Transfer IDs already looked up in IndexedDB (cleared for an ID after a decoder restart). */
const resumeChecked = new Set<string>()
let resumed = 0
/** `kept` when the last export was requested; the next runs only when it grew. */
let exportedKept = 0
/** Verification failures seen; a new one means the saved tiles are poisoned. */
let failedSeen = 0
let renderQueued = false
let wakeLock: WakeLockSentinel | null = null

function setStatus(text: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): void {
  statusEl.textContent = text
  statusEl.dataset.tone = tone
}

// --- capture ------------------------------------------------------------------

function schedule(gen: number): void {
  if (!scanning || gen !== loopGen) return
  if ('requestVideoFrameCallback' in video) frameHandle = { rvfc: true, id: video.requestVideoFrameCallback((now) => onFrame(now, gen)) }
  else frameHandle = { rvfc: false, id: requestAnimationFrame((now) => onFrame(now, gen)) }
}

function cancelFrames(): void {
  loopGen++
  if (frameHandle?.rvfc) video.cancelVideoFrameCallback(frameHandle.id)
  else if (frameHandle) cancelAnimationFrame(frameHandle.id)
  frameHandle = null
}

function onFrame(now: number, gen: number): void {
  if (!scanning || gen !== loopGen) return
  try {
    captureTimes.push(now)
    captureTimes = captureTimes.filter((t) => t > now - 2000)
    if (!busy) grab(now)
  } catch (err) {
    workerError = `프레임을 읽지 못했습니다: ${(err as Error).message}`
    queueRender()
  } finally {
    schedule(gen)
  }
}

function grab(now: number): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  const width = scanWidth(SCAN_PARAM, vw)
  const height = Math.max(1, Math.round((vh * width) / vw))
  if (scanCanvas.width !== width || scanCanvas.height !== height) {
    scanCanvas.width = overlay.width = width
    scanCanvas.height = overlay.height = height
  }
  scanCtx.drawImage(video, 0, 0, width, height)
  const pixels = scanCtx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer
  send({ type: 'frame', id: ++seq, width, height, pixels, capturedAt: now }, [pixels])
  busy = true
}

worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
  switch (data.type) {
    case 'ready':
      break
    case 'result':
      onResult(data)
      break
    case 'dropped':
      busy = false
      break
    case 'exported':
      void saveProgress(data.transferId, data.bytes, data.tiles)
      break
    case 'imported':
      onImported(data)
      break
    case 'restarted': {
      // The new instance starts empty: look the transfer up in IndexedDB again.
      const id = last?.meta?.id
      if (id) {
        resumeChecked.delete(id)
        void tryResume(id)
      }
      failedSeen = 0
      workerError = '디코더를 다시 시작했습니다. 저장된 진행 상태에서 이어 받습니다.'
      queueRender()
      break
    }
    case 'error':
      if (data.id !== undefined || data.fatal) busy = false
      workerError = data.message
      console.error(`decoder: ${data.message}`)
      queueRender()
      break
  }
}
// A crashed worker never replies; without this the loop would wait on `busy` forever.
worker.onerror = (event) => {
  busy = false
  workerError = `디코더 오류: ${event.message}`
  queueRender()
}

function onResult(r: Extract<FromWorker, { type: 'result' }>): void {
  busy = false
  const now = performance.now()
  const s = r.stats
  last = s
  workerError = s.error && !s.done ? `검증 실패, 다시 모으는 중 (${s.error})` : ''
  decodeMs = decodeMs ? decodeMs * 0.8 + r.ms * 0.2 : r.ms
  resultTimes.push(now)
  resultTimes = resultTimes.filter((t) => t > now - 2000)
  frames = trim([...frames, { t: r.capturedAt, grid: s.detected, tilesOk: s.tiles.ok, tiles: s.tiles.total }], 2000)
  progress = trim([...progress, { t: now, have: s.symbols.have }], 5000)
  if (s.meta) {
    if (s.failed > failedSeen) {
      // A failed verification restarts the decode: what was saved is poisoned.
      if (store.available) void store.remove(s.meta.id).catch(() => {})
      exportedKept = 0
    }
    if (!resumeChecked.has(s.meta.id)) {
      resumeChecked.add(s.meta.id)
      void tryResume(s.meta.id)
    }
  }
  failedSeen = s.failed
  if (r.file && s.meta) finish(r.file, s)
  drawOverlay(s)
  queueRender()
}

// --- overlay --------------------------------------------------------------------

function drawOverlay(s: ReceiverStats): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  const c = s.corners
  if (!c || c.some((v) => v === null)) return
  const line = Math.max(3, overlay.width / 300)
  const ok = s.tiles.total ? s.tiles.ok / s.tiles.total : 0
  overlayCtx.strokeStyle = ok >= 0.7 ? '#3ddc97' : ok > 0 ? '#f5a524' : '#f2555a'
  overlayCtx.lineWidth = line
  overlayCtx.beginPath()
  for (let i = 0; i < 4; i++) overlayCtx.lineTo(c[i * 2]!, c[i * 2 + 1]!)
  overlayCtx.closePath()
  overlayCtx.stroke()
  if (!DEBUG) return
  const f = s.finders ?? []
  overlayCtx.fillStyle = '#5aa9ff'
  for (let i = 0; i + 1 < f.length; i += 2) overlayCtx.fillRect((f[i] ?? -99) - line, (f[i + 1] ?? -99) - line, 2 * line, 2 * line)
  const centers = s.tile_centers ?? []
  for (let n = 0; 2 * n + 1 < centers.length; n++) {
    if (centers[2 * n] === null || centers[2 * n + 1] === null) continue
    overlayCtx.fillStyle = s.tile_status[n] === '1' ? '#3ddc97' : '#f2555a'
    overlayCtx.beginPath()
    overlayCtx.arc(centers[2 * n]!, centers[2 * n + 1]!, line * 2.5, 0, Math.PI * 2)
    overlayCtx.fill()
  }
}

// --- screen ---------------------------------------------------------------------

function queueRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

function render(): void {
  const s = last
  const capture = fps(captureTimes)
  const processed = fps(resultTimes)
  const setFps = settings.frameRate ? Math.round(settings.frameRate) : null
  stat.capture.textContent = scanning
    ? `${capture === null ? '—' : Math.round(capture)} fps${setFps ? ` (설정 ${setFps})` : ''}`
    : setFps
      ? `설정 ${setFps} fps`
      : '—'
  stat.camera.textContent = settings.width ? `${settings.width}×${settings.height}` : '—'
  stat.process.textContent = processed === null ? '—' : `${Math.round(processed)} fps`
  stat.ms.textContent = decodeMs ? `${decodeMs.toFixed(1)} ms` : '—'
  const rate = recognition(frames)
  stat.recognition.textContent = rate === null ? '—' : `${Math.round(rate * 100)}%`
  stat.grid.textContent = s?.grid ? `${s.grid.w}×${s.grid.h} ${s.grid.profile}` : '—'
  stat.foreign.textContent = s ? thousands(s.foreign) : '0'

  const need = s?.symbols.need ?? null
  const have = s?.symbols.have ?? 0
  symbolsEl.textContent = `조각 ${thousands(have)} / ${need === null ? '?' : thousands(need)}`
  const fraction = need ? Math.min(1, have / need) : 0
  percentEl.textContent = `${Math.floor(fraction * 100)}%`
  progressEl.value = fraction
  if (s?.meta) {
    fileNameEl.textContent = safeName(s.meta.name)
    fileSizeEl.textContent = `· ${formatBytes(s.meta.size)}`
    // The same 8 hex digits as the sender's status line, to tell transfers apart.
    fileIdEl.textContent = `· id ${s.meta.id}`
  }
  const left = eta(have, need, symbolRate(progress))
  stat.eta.textContent = left === null ? '—' : formatSeconds(left)

  const h = scanning && !s?.done ? hint(frames) : null
  hintEl.hidden = h === null
  if (h) {
    hintEl.textContent = `▸ ${HINT_TEXT[h]}`
    hintEl.dataset.tone = h === 'faster' ? 'ok' : ''
  }

  if (s?.done) {
    // finish() set the final message.
  } else if (s?.too_large && !s.meta) {
    setStatus(`${tooLargeText(s.too_large.size, s.limit)} · id ${s.too_large.id}`, 'bad')
  } else if (workerError) {
    setStatus(workerError, 'warn')
  } else if (!scanning) {
    if (!starting) setStatus(s?.meta ? '일시 정지됨 — 카메라를 다시 시작하면 이어서 받습니다.' : '카메라를 시작하고 송신 화면 전체를 비추세요.')
  } else if (!s?.meta) {
    setStatus(frames.some((f) => f.grid) ? '격자를 찾았습니다 · 파일 정보를 기다리는 중…' : '송신 화면 전체가 들어오게 비추세요.')
  } else {
    const remaining = Math.max(0, (need ?? 0) - have)
    const resumedText = resumed > 0 ? ` · 이어 받기 ${thousands(resumed)}개` : ''
    setStatus(`남은 조각 ${thousands(remaining)}개 · ${left === null ? '시간 계산 중' : `약 ${formatSeconds(left)}`}${resumedText}`)
  }
  if (DEBUG && s) debugEl.textContent = JSON.stringify({ ...s, tile_centers: undefined }, null, 1)
}

// --- camera -----------------------------------------------------------------------

async function startCamera(): Promise<void> {
  if (starting || scanning) return
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('카메라를 쓸 수 없습니다. HTTPS 또는 localhost로 접속했는지 확인하세요.', 'bad')
    return
  }
  if (last?.done) reset() // a finished transfer is not resumed: start a new receive
  starting = true
  startBtn.disabled = true
  setStatus('카메라를 여는 중…')
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
    })
    const [track] = stream.getVideoTracks()
    settings = track?.getSettings() ?? {}
    video.srcObject = stream
    await video.play()
    cancelFrames() // never two capture chains
    scanning = true
    startBtn.textContent = '카메라 정지'
    void keepAwake()
    schedule(loopGen)
  } catch (err) {
    stopCamera()
    setStatus(`카메라를 열지 못했습니다: ${(err as Error).message}`, 'bad')
  } finally {
    starting = false
    startBtn.disabled = false
    queueRender()
  }
}

/** Long receives should not be cut short by auto-lock (Screen Wake Lock, Safari 16.4+). */
async function keepAwake(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    wakeLock = null
  }
}

function stopCamera(): void {
  void wakeLock?.release().catch(() => {})
  wakeLock = null
  scanning = false
  cancelFrames()
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video.srcObject = null
  startBtn.textContent = '카메라 시작'
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
}

// --- completion, save, share ----------------------------------------------------------

function finish(file: ArrayBuffer, s: ReceiverStats): void {
  const name = safeName(s.meta?.name ?? 'file')
  const blob = new Blob([file], { type: 'application/octet-stream' })
  if (download) URL.revokeObjectURL(download.url)
  download = { url: URL.createObjectURL(blob), name, file: new File([blob], name, { type: 'application/octet-stream' }) }
  stopCamera()
  resultEl.hidden = false
  resultEl.dataset.tone = 'ok'
  resultText.textContent = `✓ SHA-256 확인 · ${name} (${formatBytes(file.byteLength)}) · id ${s.meta?.id ?? ''}`
  shareBtn.hidden = !(navigator.canShare?.({ files: [download.file] }) ?? false)
  setStatus('수신 완료. 파일을 저장하세요.', 'ok')
  if (s.meta && store.available) void store.remove(s.meta.id).catch(() => {})
}

function saveFile(): void {
  if (!download) return
  const a = document.createElement('a')
  a.href = download.url
  a.download = download.name
  document.body.append(a)
  a.click()
  a.remove()
}

async function shareFile(): Promise<void> {
  if (!download) return
  try {
    await navigator.share({ files: [download.file], title: download.name })
  } catch (err) {
    if ((err as Error).name !== 'AbortError') setStatus(`공유하지 못했습니다: ${(err as Error).message}`, 'warn')
  }
}

// --- resume (IndexedDB) -------------------------------------------------------------------

async function tryResume(id: string): Promise<void> {
  if (!store.available) return
  const gen = resetGen
  try {
    const saved = await store.load(id)
    // A reset while IndexedDB was busy means "start over": do not bring the old tiles back.
    if (saved && gen === resetGen && saved.tiles > 0) send({ type: 'import', bytes: saved.data, generation: gen }, [saved.data])
  } catch (err) {
    console.warn('resume lookup failed', err)
  }
}

function onImported(data: Extract<FromWorker, { type: 'imported' }>): void {
  if (data.generation !== resetGen) return
  const id = data.stats.meta?.id
  if (data.tiles < 0) {
    if (id && store.available) void store.remove(id).catch(() => {}) // unreadable: drop it
    return
  }
  resumed = data.tiles
  last = data.stats
  // The import is a jump, not a rate: measure the rate afresh from here.
  progress = [{ t: performance.now(), have: data.stats.symbols.have }]
  queueRender()
}

async function saveProgress(id: string | null, tiles: ArrayBuffer, count: number): Promise<void> {
  const meta = last?.meta
  if (!id || !meta || meta.id !== id || last?.done || !store.available || count <= 0) return
  const gen = resetGen
  try {
    // Never replace a saved entry with a smaller one (e.g. right after a decoder restart).
    const stored = await store.info(id)
    if (gen !== resetGen || (stored && stored.tiles > count)) return
    await store.save({ id, name: meta.name, size: meta.size, savedAt: Date.now(), data: tiles })
  } catch (err) {
    console.warn('saving progress failed', err)
  }
}

/** Exports collected tiles, only when more were collected since the last export. */
function requestSave(): void {
  if (!last?.meta || last.done || last.kept <= exportedKept) return
  exportedKept = last.kept
  send({ type: 'export', id: ++seq })
}
setInterval(requestSave, 5000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') requestSave()
  else if (scanning && (!wakeLock || wakeLock.released)) void keepAwake() // the lock is dropped while hidden
})
if (store.available) void store.evict().catch(() => {})

// --- reset ------------------------------------------------------------------------------

function reset(): void {
  resetGen++
  const id = last?.meta?.id
  if (id && store.available) void store.remove(id).catch(() => {})
  if (id) resumeChecked.add(id) // a reset means start over: do not re-import it
  send({ type: 'reset' })
  last = null
  frames = []
  progress = []
  decodeMs = 0
  resumed = 0
  exportedKept = 0
  failedSeen = 0
  workerError = ''
  if (download) URL.revokeObjectURL(download.url)
  download = null
  resultEl.hidden = true
  fileNameEl.textContent = '—'
  fileSizeEl.textContent = ''
  fileIdEl.textContent = ''
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  queueRender()
}

startBtn.addEventListener('click', () => (scanning ? (stopCamera(), queueRender()) : void startCamera()))
resetBtn.addEventListener('click', reset)
downloadBtn.addEventListener('click', saveFile)
shareBtn.addEventListener('click', () => void shareFile())
setInterval(queueRender, 500)
render()
