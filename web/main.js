// @ts-check
// DiodeCam receiver (docs/web.md): camera → requestVideoFrameCallback →
// canvas → decoder worker (WebAssembly) → progress, verified file, save/share.
// Everything stays in this browser; nothing is uploaded.
//
// Every internal URL carries `?v=__V__`, which the deploy (ci.yml) replaces with
// the commit, so a browser never mixes files from two deploys.

import {
  HINT_TEXT,
  STAGE_TEXT,
  eta,
  failure,
  formatBytes,
  formatSeconds,
  fps,
  hint,
  limitMib,
  moduleSize,
  quantile,
  recognition,
  safeName,
  scanWidth,
  symbolRate,
  thousands,
  tooLargeText,
  trim,
} from './metrics.js?v=__V__'
import * as store from './store.js?v=__V__'

/** @import { FrameSample, ProgressSample } from './metrics.js' */
/** @import { ReceiverStats } from './wasm.js' */
/** @import { FromWorker, ToWorker } from './worker.js' */

const params = new URLSearchParams(location.search)
/** `?scan=`: width of the image handed to the decoder (see scanWidth). */
const SCAN_PARAM = params.get('scan')
/** `?max=`: largest file accepted, in MiB. */
const LIMIT_MIB = limitMib(params.get('max'))
const DEBUG = params.get('debug') === '1'
/** The commit on the deployed site; still `__V__` in a local copy. */
const VERSION = '__V__'
const CAMERA_KEY = 'diodecam.camera'

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
const video = /** @type {HTMLVideoElement} */ ($('preview'))
const viewer = /** @type {HTMLElement} */ (video.parentElement)
const overlay = /** @type {HTMLCanvasElement} */ ($('overlay'))
const statusEl = $('status')
const startBtn = /** @type {HTMLButtonElement} */ ($('start'))
const fileNameEl = $('file-name')
const fileSizeEl = $('file-size')
const fileIdEl = $('file-id')
const symbolsEl = $('symbols')
const percentEl = $('percent')
const progressEl = /** @type {HTMLProgressElement} */ ($('progress'))
const hintEl = $('hint')
const resultEl = $('result')
const resultText = $('result-text')
const shareBtn = $('share')
const downloadBtn = $('download')
const debugEl = $('debug')
const summaryEl = $('summary')
const cameraSelect = /** @type {HTMLSelectElement} */ ($('camera-select'))
const copyBtn = $('copy')
const stat = {
  capture: $('stat-capture'),
  process: $('stat-process'),
  ms: $('stat-ms'),
  recognition: $('stat-recognition'),
  grid: $('stat-grid'),
  module: $('stat-module'),
  stage: $('stat-stage'),
  eta: $('stat-eta'),
  camera: $('stat-camera'),
  lens: $('stat-lens'),
  foreign: $('stat-foreign'),
}

const scanCanvas = document.createElement('canvas')
const scanCtx = /** @type {CanvasRenderingContext2D} */ (scanCanvas.getContext('2d', { willReadFrequently: true }))
const overlayCtx = /** @type {CanvasRenderingContext2D} */ (overlay.getContext('2d'))

const worker = new Worker(new URL('./worker.js?v=__V__', import.meta.url), { type: 'module' })
/**
 * @param {ToWorker} msg
 * @param {Transferable[]} [transfer]
 */
const send = (msg, transfer = []) => worker.postMessage(msg, transfer)
send({ type: 'limit', mib: LIMIT_MIB })
if (DEBUG) {
  send({ type: 'debug', on: true })
  debugEl.hidden = false
  const details = /** @type {HTMLDetailsElement} */ ($('details'))
  details.open = true
}
// Offline copy for the home-screen app (sw.js); only where the build stamped a version.
// The one unversioned URL: the browser re-checks a service worker script itself,
// and its bytes change with every deploy. After `load`, so the first visit does
// not download the wasm twice.
if (!VERSION.startsWith('__') && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('offline cache unavailable', err)))
}

/** @type {MediaStream | null} */
let stream = null
let scanning = false
let starting = false
let busy = false
/** Bumped when the camera starts or stops: frame callbacks of an earlier chain exit. */
let loopGen = 0
/** Bumped by reset(): results of IndexedDB reads that started before it are dropped. */
let resetGen = 0
/** @type {MediaTrackSettings} */
let settings = {}
/** The camera's own name (iOS: which back camera, e.g. wide or triple). */
let lens = ''
/** @type {ReceiverStats | null} */
let last = null
let decodeMs = 0
/** @type {FrameSample[]} */
let frames = []
/** @type {ProgressSample[]} */
let progress = []
/** @type {number[]} */
let captureTimes = []
/** @type {number[]} */
let resultTimes = []
let workerError = ''
/**
 * What the last action failed on (camera, share); stays until the next action.
 * @type {{ text: string, tone: 'warn' | 'bad' } | null}
 */
let notice = null
/**
 * The verified file on offer; `restored` when it came back from IndexedDB after a
 * reload, `saved` once downloaded or shared.
 * @type {{ url: string, name: string, file: File, id: string, at: number, restored: boolean, saved: boolean } | null}
 */
let offer = null
/** @type {Set<string>} Transfer IDs already looked up in IndexedDB. */
const resumeChecked = new Set()
let resumed = 0
/** `kept` when the last export was requested; the next runs only when it grew. */
let exportedKept = 0
/** Verification failures seen; a new one means the saved tiles are poisoned. */
let failedSeen = 0
let renderQueued = false
/** @type {WakeLockSentinel | null} */
let wakeLock = null

/** Diagnostics since the camera started (docs/web.md §6): where frames stopped, and how good the grids were. */
function newSession() {
  return {
    started: performance.now(),
    frames: 0,
    /** @type {Record<string, number>} */
    stages: {},
    detections: 0,
    tracked: 0,
    corrected: 0,
    /** @type {number[]} */
    modules: [],
    /** @type {number[]} */
    residuals: [],
  }
}
let session = newSession()

/**
 * @param {string} text
 * @param {'ok' | 'warn' | 'bad' | ''} [tone]
 */
function setStatus(text, tone = '') {
  statusEl.textContent = text
  statusEl.dataset.tone = tone
}

// --- capture ------------------------------------------------------------------

/** @param {number} gen */
function schedule(gen) {
  if (!scanning || gen !== loopGen) return
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback((now) => onFrame(now, gen))
  else requestAnimationFrame((now) => onFrame(now, gen))
}

/**
 * @param {number} now
 * @param {number} gen
 */
function onFrame(now, gen) {
  if (!scanning || gen !== loopGen) return
  try {
    captureTimes.push(now)
    captureTimes = captureTimes.filter((t) => t > now - 2000)
    if (!busy) grab(now)
  } catch (err) {
    workerError = `프레임을 읽지 못했습니다: ${/** @type {Error} */ (err).message}`
    queueRender()
  } finally {
    schedule(gen)
  }
}

/** @param {number} now */
function grab(now) {
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
  const pixels = scanCtx.getImageData(0, 0, width, height).data.buffer
  send({ type: 'frame', width, height, pixels, capturedAt: now }, [pixels])
  busy = true
}

worker.onmessage = (/** @type {MessageEvent<FromWorker>} */ { data }) => {
  switch (data.type) {
    case 'result':
      onResult(data)
      break
    case 'exported':
      void saveProgress(data.transferId, data.bytes, data.tiles)
      break
    case 'imported':
      onImported(data)
      break
    case 'error':
      busy = false
      console.error(`decoder: ${data.message}`)
      if (data.fatal) fatal()
      else workerError = data.message
      queueRender()
      break
  }
}
// A crashed worker never replies; without this the loop would wait on `busy` forever.
worker.onerror = (event) => {
  console.error(`decoder: ${event.message}`)
  fatal()
  queueRender()
}

/** The decoder is gone: stop, and let a reload pick up the saved progress. */
function fatal() {
  stopCamera()
  startBtn.disabled = true
  workerError = '디코더 오류 — 새로고침하면 저장된 진행분에서 이어 받습니다.'
}

/** @param {Extract<FromWorker, { type: 'result' }>} r */
function onResult(r) {
  busy = false
  const now = performance.now()
  const s = r.stats
  last = s
  workerError = s.error && !s.done ? `검증 실패, 다시 모으는 중 (${s.error})` : ''
  decodeMs = decodeMs ? decodeMs * 0.8 + r.ms * 0.2 : r.ms
  resultTimes.push(now)
  resultTimes = resultTimes.filter((t) => t > now - 2000)
  const module = s.detected ? moduleSize(s.corners, s.grid) : null
  frames = trim([...frames, { t: r.capturedAt, grid: s.detected, tilesOk: s.tiles.ok, tiles: s.tiles.total, stage: s.stage, module }], 2000)
  progress = trim([...progress, { t: now, have: s.symbols.have }], 5000)
  note(s, module)
  // Another transfer has begun: the kept file leaves the screen (it stays stored until this one completes).
  if (offer && s.meta && s.meta.id !== offer.id && !s.done) clearOffer()
  if (s.meta) {
    if (s.failed > failedSeen) {
      // A failed verification restarts the decode: what was saved is poisoned.
      store.remove(s.meta.id).catch(() => {})
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

/**
 * @param {ReceiverStats} s
 * @param {number | null} module
 */
function note(s, module) {
  session.frames++
  const stage = s.stage ?? 'none'
  session.stages[stage] = (session.stages[stage] ?? 0) + 1
  if (!s.detected) return
  session.detections++
  if (s.tracked) session.tracked++
  if (s.corrected) session.corrected++
  if (module !== null) session.modules.push(module)
  if (typeof s.residual === 'number') session.residuals.push(s.residual)
  if (session.modules.length > 600) session.modules.splice(0, 300)
  if (session.residuals.length > 600) session.residuals.splice(0, 300)
}

// --- overlay --------------------------------------------------------------------

/** @param {ReceiverStats} s */
function drawOverlay(s) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  const c = s.corners
  if (!c || c.some((v) => v === null)) return
  const line = Math.max(3, overlay.width / 300)
  const ok = s.tiles.total ? s.tiles.ok / s.tiles.total : 0
  overlayCtx.strokeStyle = ok >= 0.7 ? '#34d399' : ok > 0 ? '#fbbf24' : '#f87171'
  overlayCtx.lineWidth = line
  overlayCtx.beginPath()
  for (let i = 0; i < 4; i++) overlayCtx.lineTo(c[i * 2] ?? 0, c[i * 2 + 1] ?? 0)
  overlayCtx.closePath()
  overlayCtx.stroke()
  if (!DEBUG) return
  const f = s.finders ?? []
  overlayCtx.fillStyle = '#5aa9ff'
  for (let i = 0; i + 1 < f.length; i += 2) overlayCtx.fillRect((f[i] ?? -99) - line, (f[i + 1] ?? -99) - line, 2 * line, 2 * line)
  const centers = s.tile_centers ?? []
  for (let n = 0; 2 * n + 1 < centers.length; n++) {
    const x = centers[2 * n]
    const y = centers[2 * n + 1]
    if (x == null || y == null) continue
    overlayCtx.fillStyle = s.tile_status[n] === '1' ? '#34d399' : '#f87171'
    overlayCtx.beginPath()
    overlayCtx.arc(x, y, line * 2.5, 0, Math.PI * 2)
    overlayCtx.fill()
  }
}

// --- screen ---------------------------------------------------------------------

function queueRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

function render() {
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
  stat.lens.textContent = lens || '—'
  stat.process.textContent = processed === null ? '—' : `${Math.round(processed)} fps`
  stat.ms.textContent = decodeMs ? `${decodeMs.toFixed(1)} ms` : '—'
  const rate = recognition(frames)
  stat.recognition.textContent = rate === null ? '—' : `${Math.round(rate * 100)}%`
  stat.grid.textContent = s?.grid ? `${s.grid.w}×${s.grid.h} ${s.grid.profile}` : '—'
  const module = quantile(frames.map((f) => f.module), 0.5)
  stat.module.textContent = module === null ? '—' : `${module.toFixed(1)} px`
  const failed = failure(frames)
  stat.stage.textContent = failed ? `${STAGE_TEXT[failed.stage]} ${Math.round(failed.share * 100)}%` : frames.length && scanning ? '없음' : '—'
  stat.foreign.textContent = s ? thousands(s.foreign) : '0'
  summaryEl.textContent = scanning
    ? [rate === null ? '' : `인식 ${Math.round(rate * 100)}%`, module === null ? '' : `모듈 ${module.toFixed(1)} px`, capture === null ? '' : `${Math.round(capture)} fps`]
        .filter(Boolean)
        .join(' · ')
    : ''

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

  const h = scanning && !s?.done ? hint(frames, video.videoHeight > video.videoWidth) : null
  hintEl.hidden = h === null
  if (h) {
    hintEl.textContent = `▸ ${HINT_TEXT[h]}`
    hintEl.dataset.tone = h === 'faster' ? 'ok' : ''
  }

  if (notice) {
    setStatus(notice.text, notice.tone)
  } else if (starting) {
    setStatus('카메라를 여는 중…')
  } else if (s?.too_large && !s.meta) {
    setStatus(`${tooLargeText(s.too_large.size, s.limit)} · id ${s.too_large.id}`, 'bad')
  } else if (workerError) {
    setStatus(workerError, 'warn')
  } else if (offer && !scanning) {
    setStatus(offer.restored ? '받은 파일이 남아 있습니다. 저장하거나 공유하세요.' : '수신 완료. 파일을 저장하세요.', 'ok')
  } else if (!scanning) {
    setStatus(s?.meta ? '일시 정지됨 — 카메라를 다시 시작하면 이어서 받습니다.' : '카메라를 시작하고 송신 화면 전체를 비추세요.')
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

async function startCamera() {
  if (starting || scanning) return
  notice = null
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice = { text: '카메라를 쓸 수 없습니다. HTTPS 또는 localhost로 접속했는지 확인하세요.', tone: 'bad' }
    queueRender()
    return
  }
  if (last?.done) reset() // a finished transfer is not resumed: start a new receive
  starting = true
  startBtn.disabled = true
  queueRender()
  try {
    stream = await openCamera(readCamera())
    const track = stream.getVideoTracks()[0]
    settings = track?.getSettings() ?? {}
    lens = track?.label ?? ''
    video.srcObject = stream
    await video.play()
    loopGen++ // never two capture chains
    scanning = true
    viewer.classList.add('live')
    frames = []
    session = newSession()
    startBtn.textContent = '카메라 정지'
    void keepAwake()
    void listCameras()
    schedule(loopGen)
  } catch (err) {
    stopCamera()
    notice = { text: `카메라를 열지 못했습니다: ${/** @type {Error} */ (err).message}`, tone: 'bad' }
  } finally {
    starting = false
    startBtn.disabled = false
    queueRender()
  }
}

/**
 * The chosen camera, or the default back camera. A chosen one that is gone
 * (another device, or its ID was reset) falls back to the default and is forgotten.
 * @param {string} deviceId
 */
async function openCamera(deviceId) {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }
  const auto = () => navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: { ideal: 'environment' } } })
  if (!deviceId) return auto()
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, deviceId: { exact: deviceId } } })
  } catch (err) {
    const name = /** @type {Error} */ (err).name
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err // busy, denied: keep the choice
    writeCamera('')
    return auto()
  }
}

/**
 * Fills the camera list (labels are only known once the camera is allowed). On
 * an iPhone with several back cameras, a single lens ("후면 카메라") does not
 * switch lenses by itself the way the default multi-lens camera can up close.
 */
async function listCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    const chosen = readCamera()
    cameraSelect.replaceChildren(new Option('자동 (후면 기본)', ''), ...cams.map((d, i) => new Option(d.label || `카메라 ${i + 1}`, d.deviceId)))
    cameraSelect.value = cams.some((d) => d.deviceId === chosen) ? chosen : ''
    cameraSelect.disabled = cams.length === 0
  } catch (err) {
    console.warn('camera list unavailable', err)
  }
}

// The chosen camera is a per-browser convenience: without storage it is simply not remembered.
function readCamera() {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? ''
  } catch {
    return ''
  }
}

/** @param {string} deviceId */
function writeCamera(deviceId) {
  try {
    if (deviceId) localStorage.setItem(CAMERA_KEY, deviceId)
    else localStorage.removeItem(CAMERA_KEY)
  } catch {
    // not remembered
  }
}

/** Long receives should not be cut short by auto-lock (Screen Wake Lock, Safari 16.4+). */
async function keepAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    wakeLock = null
  }
}

function stopCamera() {
  void wakeLock?.release().catch(() => {})
  wakeLock = null
  scanning = false
  viewer.classList.remove('live')
  loopGen++
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video.srcObject = null
  startBtn.textContent = '카메라 시작'
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
}

// --- completion, save, share ----------------------------------------------------------

/**
 * @param {ArrayBuffer} file
 * @param {ReceiverStats} s
 */
function finish(file, s) {
  const name = safeName(s.meta?.name ?? 'file')
  const id = s.meta?.id ?? ''
  const blob = new Blob([file], { type: 'application/octet-stream' })
  stopCamera()
  const at = Date.now()
  show(blob, name, id, at, false)
  resultEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  if (s.meta) store.remove(s.meta.id).catch(() => {})
  // Kept until the next file or a reset, so closing the tab before saving does not lose it.
  store.keepFile({ id, name, size: blob.size, receivedAt: at, blob }).catch((err) => console.warn('keeping the file failed', err))
}

/**
 * Offers a verified file: the share sheet first where it takes files (iOS: AirDrop, Files), else a download.
 * @param {Blob} blob
 * @param {string} name
 * @param {string} id
 * @param {number} at
 * @param {boolean} restored
 */
function show(blob, name, id, at, restored) {
  clearOffer()
  const file = new File([blob], name, { type: 'application/octet-stream' })
  offer = { url: URL.createObjectURL(file), name, file, id, at, restored, saved: false }
  const time = new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  resultText.textContent = `✓ SHA-256 확인 · ${name} (${formatBytes(file.size)}) · id ${id}${restored ? ` · ${time}에 받음` : ''}`
  shareBtn.hidden = !(navigator.canShare?.({ files: [file] }) ?? false)
  downloadBtn.classList.toggle('primary', shareBtn.hidden)
  resultEl.hidden = false
  queueRender()
}

function clearOffer() {
  if (offer) URL.revokeObjectURL(offer.url)
  offer = null
  resultEl.hidden = true
}

/** After a reload: the file received earlier and not yet replaced or reset. */
async function restoreKept() {
  const gen = resetGen
  try {
    const kept = await store.keptFile()
    if (kept && gen === resetGen && !offer && !last?.meta) show(kept.blob, safeName(kept.name), kept.id, kept.receivedAt, true)
  } catch (err) {
    console.warn('kept file lookup failed', err)
  }
}

function saveFile() {
  if (!offer) return
  offer.saved = true
  const a = document.createElement('a')
  a.href = offer.url
  a.download = offer.name
  document.body.append(a)
  a.click()
  a.remove()
}

async function shareFile() {
  if (!offer) return
  notice = null
  try {
    await navigator.share({ files: [offer.file], title: offer.name })
    // Shared (saved to Files, sent by AirDrop): the stored copy is no longer needed; the card stays.
    offer.saved = true
    store.dropFile().catch(() => {})
  } catch (err) {
    if (/** @type {Error} */ (err).name !== 'AbortError') notice = { text: `공유하지 못했습니다: ${/** @type {Error} */ (err).message}`, tone: 'warn' }
  }
  queueRender()
}

// --- diagnostics ------------------------------------------------------------------------

/**
 * What `진단 복사` copies: device, camera and recognition numbers. No file name,
 * content, size or transfer ID, and no device IDs.
 */
function diagnostics() {
  const track = stream?.getVideoTracks()[0]
  /** @param {object | undefined} o */
  const withoutIds = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'deviceId' && k !== 'groupId')) : null)
  /** @param {number[]} v @param {number} q */
  const at = (v, q) => {
    const x = quantile(v, q)
    return x === null ? null : Math.round(x * 100) / 100
  }
  const s = last
  const rate = recognition(frames)
  const capture = fps(captureTimes)
  const processed = fps(resultTimes)
  return {
    app: `DiodeCam ${VERSION}`,
    at: new Date().toISOString(),
    agent: navigator.userAgent,
    standalone: matchMedia('(display-mode: standalone)').matches,
    viewport: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    camera: {
      lens: lens || null,
      chosen: readCamera() ? 'manual' : 'auto',
      video: `${video.videoWidth}×${video.videoHeight}`,
      settings: withoutIds(settings),
      capabilities: withoutIds(track?.getCapabilities?.()),
    },
    scan: `${scanCanvas.width}×${scanCanvas.height}`,
    session: {
      seconds: Math.round((performance.now() - session.started) / 1000),
      frames: session.frames,
      stages: session.stages,
      grids: session.detections,
      tracked: session.tracked,
      corrected: session.corrected,
      module_px: { p10: at(session.modules, 0.1), p50: at(session.modules, 0.5), p90: at(session.modules, 0.9) },
      residual_p50: at(session.residuals, 0.5),
    },
    recent: {
      capture_fps: capture && Math.round(capture),
      process_fps: processed && Math.round(processed),
      decode_ms: Math.round(decodeMs * 10) / 10,
      recognition: rate === null ? null : Math.round(rate * 1000) / 1000,
      hint: scanning ? hint(frames, video.videoHeight > video.videoWidth) : null,
    },
    grid: s?.grid ?? null,
    // Progress only: the transfer ID and exact size together could identify the file.
    transfer: s?.meta
      ? { progress: Math.round((s.symbols.have / (s.symbols.need || 1)) * 100) / 100, foreign: s.foreign, invalid: s.invalid, failed: s.failed, done: s.done }
      : null,
  }
}

async function copyDiagnostics() {
  const text = JSON.stringify(diagnostics(), null, 1)
  try {
    await navigator.clipboard.writeText(text)
    debugEl.hidden = !DEBUG
    copyBtn.textContent = '복사했습니다 ✓'
  } catch {
    // No clipboard (permission, old browser): show it to copy by hand.
    debugEl.hidden = false
    debugEl.textContent = text
    copyBtn.textContent = '아래 글을 길게 눌러 복사하세요'
  }
  setTimeout(() => (copyBtn.textContent = '진단 복사'), 3000)
}

// --- resume (IndexedDB) -------------------------------------------------------------------

/** @param {string} id */
async function tryResume(id) {
  const gen = resetGen
  try {
    const saved = await store.load(id)
    // A reset while IndexedDB was busy means "start over": do not bring the old tiles back.
    if (saved && gen === resetGen && saved.tiles > 0) send({ type: 'import', bytes: saved.data, generation: gen }, [saved.data])
  } catch (err) {
    console.warn('resume lookup failed', err)
  }
}

/** @param {Extract<FromWorker, { type: 'imported' }>} data */
function onImported(data) {
  if (data.generation !== resetGen) return
  if (data.tiles < 0) {
    const id = data.stats.meta?.id
    if (id) store.remove(id).catch(() => {}) // unreadable: drop it
    return
  }
  resumed = data.tiles
  last = data.stats
  // The import is a jump, not a rate: measure the rate afresh from here.
  progress = [{ t: performance.now(), have: data.stats.symbols.have }]
  queueRender()
}

/**
 * @param {string | null} id
 * @param {ArrayBuffer} tiles
 * @param {number} count
 */
async function saveProgress(id, tiles, count) {
  const meta = last?.meta
  if (!id || !meta || meta.id !== id || last?.done || count <= 0) return
  const gen = resetGen
  try {
    // Never replace a saved entry with a smaller one (an export made while saved tiles were being re-imported).
    const stored = await store.info(id)
    if (gen !== resetGen || (stored && stored.tiles > count)) return
    await store.save({ id, name: meta.name, size: meta.size, savedAt: Date.now(), data: tiles })
  } catch (err) {
    console.warn('saving progress failed', err)
  }
}

/** Exports collected tiles, only when more were collected since the last export. */
function requestSave() {
  if (!last?.meta || last.done || last.kept <= exportedKept) return
  exportedKept = last.kept
  send({ type: 'export' })
}
setInterval(requestSave, 5000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') requestSave()
  else if (scanning && (!wakeLock || wakeLock.released)) void keepAwake() // the lock is dropped while hidden
})
store.evict().catch(() => {})

// --- reset ------------------------------------------------------------------------------

function reset() {
  resetGen++
  const id = last?.meta?.id
  if (id) {
    store.remove(id).catch(() => {})
    resumeChecked.add(id) // a reset means start over: do not re-import it
  }
  send({ type: 'reset' })
  last = null
  frames = []
  progress = []
  decodeMs = 0
  resumed = 0
  exportedKept = 0
  failedSeen = 0
  workerError = ''
  fileNameEl.textContent = '—'
  fileSizeEl.textContent = ''
  fileIdEl.textContent = ''
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  queueRender()
}

startBtn.addEventListener('click', () => (scanning ? (stopCamera(), queueRender()) : void startCamera()))
// Start over: the collected tiles and the kept file both go.
$('reset').addEventListener('click', () => {
  if (offer && !offer.saved && !confirm('받은 파일을 아직 저장하지 않았습니다. 지울까요?')) return
  notice = null
  reset()
  clearOffer()
  store.dropFile().catch(() => {})
})
downloadBtn.addEventListener('click', saveFile)
shareBtn.addEventListener('click', () => void shareFile())
copyBtn.addEventListener('click', () => void copyDiagnostics())
cameraSelect.addEventListener('change', () => {
  writeCamera(cameraSelect.value)
  if (!scanning) return
  stopCamera()
  void startCamera()
})
setInterval(queueRender, 500)
void restoreKept().then(queueRender)
render()
