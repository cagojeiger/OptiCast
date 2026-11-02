// @ts-check
// DiodeCam receiver (docs/web.md): camera → requestVideoFrameCallback →
// canvas → decoder worker (WebAssembly) → progress, verified file, save/share.
// Everything stays in this browser; nothing is uploaded.
//
// Every internal URL carries `?v=__V__`, which the deploy (ci.yml) replaces with
// the commit, so a browser never mixes files from two deploys.

import {
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
  captureWidth,
  scanWidth,
  symbolRate,
  thousands,
  trim,
} from './metrics.js?v=__V__'
import * as store from './store.js?v=__V__'
import { diagnostics, view } from './view.js?v=__V__'

/** @import { FrameSample, ProgressSample } from './metrics.js' */
/** @import { Session } from './view.js' */
/** @import { ReceiverStats } from './wasm.js' */
/** @import { FromWorker, ToWorker } from './worker.js' */

const params = new URLSearchParams(location.search)
/** `?scan=`: width of the image handed to the decoder (see scanWidth). */
const SCAN_PARAM = params.get('scan')
/** `?cap=`: width asked of the camera (see captureWidth); pair with `?scan=` of the same value. */
const CAP_WIDTH = captureWidth(params.get('cap'))
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
const stripEl = $('strip')
const stripState = $('strip-state')
const stripExtra = $('strip-extra')
const stripRight = $('strip-right')
const barEl = $('bar')
const ringEl = $('ring')
const ringLabel = $('ring-label')
const tickEl = $('tick')
const promptEl = $('prompt')
const hintEl = $('hint')
const fileEl = /** @type {HTMLElement} */ (fileNameEl.parentElement)
const progressSection = /** @type {HTMLElement} */ (document.querySelector('.progress'))
const startLabel = $('start-label')
const shareBtn = /** @type {HTMLButtonElement} */ ($('share'))
const downloadBtn = /** @type {HTMLButtonElement} */ ($('download'))
const resetBtn = /** @type {HTMLButtonElement} */ ($('reset'))
const senderSheet = /** @type {HTMLDialogElement} */ ($('sender-sheet'))
const statsSheet = /** @type {HTMLDialogElement} */ ($('stats-sheet'))
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
/** Set by fatal(): the decoder is gone until a reload. */
let fatalError = ''
/**
 * What the last action failed on (camera, share); stays until the next action.
 * @type {{ text: string, tone: 'warn' | 'bad' } | null}
 */
let notice = null
/**
 * The saved progress could not be imported (only out of memory). Reception goes on, so it is a
 * warning, not an error; it goes once new progress is saved or the file completes.
 * @type {{ text: string, tone: 'warn' }}
 */
const RESTORE_FAILED = { text: 'Could not restore the saved progress. Collecting again; reload to retry.', tone: 'warn' }
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

/** @returns {Session} Diagnostics since the camera started (docs/web.md §6). */
function newSession() {
  return {
    started: performance.now(),
    frames: 0,
    stages: {},
    detections: 0,
    tracked: 0,
    corrected: 0,
    modules: [],
    residuals: [],
    lastFrame: null,
    gaps: { count: 0, ms: 0, longest: 0, last: [] },
  }
}
/** No camera frame for longer than this is a gap in the session's record. */
const GAP_MS = 500
let session = newSession()

/** @param {string} d */
function pathEl(d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  return p
}

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
    const gap = session.lastFrame === null ? 0 : now - session.lastFrame
    if (gap > GAP_MS) {
      const g = session.gaps
      g.count++
      g.ms += gap
      g.longest = Math.max(g.longest, gap)
      g.last = [...g.last.slice(-9), { at: now - gap, ms: gap }]
    }
    session.lastFrame = now
    if (!busy) grab(now)
  } catch (err) {
    workerError = `Could not read a frame: ${/** @type {Error} */ (err).message}`
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
  fatalError = 'Decoder error. Reload to resume from the saved progress.'
}

/** @param {Extract<FromWorker, { type: 'result' }>} r */
function onResult(r) {
  busy = false
  const now = performance.now()
  const s = r.stats
  last = s
  workerError = s.error && !s.done ? `Verification failed, collecting again (${s.error})` : ''
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
  viewer.classList.toggle('detected', !!s.detected)
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

/** Start's icon by its label: play, stop, and the reset arrow for Reload. */
const START_ICON = { Start: 'M7 4l13 8-13 8z', Stop: 'M5 5h14v14H5z', Reload: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5' }

function render() {
  const s = last
  // The windows end now, not at the newest sample: when frames stop (a rotation, a taken
  // camera), the recent numbers go blank instead of freezing at their last values.
  const now = performance.now()
  const recent = trim(frames, 2000, now)
  const capture = fps(captureTimes.filter((t) => t > now - 2000))
  const processed = fps(resultTimes.filter((t) => t > now - 2000))
  const setFps = settings.frameRate ? Math.round(settings.frameRate) : null
  stat.capture.textContent = scanning
    ? `${capture === null ? '—' : Math.round(capture)} fps${setFps ? ` (set ${setFps})` : ''}`
    : setFps
      ? `set ${setFps} fps`
      : '—'
  stat.camera.textContent = settings.width ? `${settings.width}×${settings.height}` : '—'
  stat.lens.textContent = lens || '—'
  stat.process.textContent = processed === null ? '—' : `${Math.round(processed)} fps`
  stat.ms.textContent = decodeMs ? `${decodeMs.toFixed(1)} ms` : '—'
  const rate = recognition(recent)
  stat.recognition.textContent = rate === null ? '—' : `${Math.round(rate * 100)}%`
  stat.grid.textContent = s?.grid ? `${s.grid.w}×${s.grid.h} ${s.grid.profile}` : '—'
  const module = quantile(recent.map((f) => f.module), 0.5)
  stat.module.textContent = module === null ? '—' : `${module.toFixed(1)} px`
  const failed = failure(recent)
  stat.stage.textContent = failed ? `${STAGE_TEXT[failed.stage]} ${Math.round(failed.share * 100)}%` : recent.length && scanning ? 'nothing' : '—'
  stat.foreign.textContent = s ? thousands(s.foreign) : '0'
  summaryEl.textContent = scanning
    ? [rate === null ? '' : `${Math.round(rate * 100)}% read`, module === null ? '' : `${module.toFixed(1)} px`, capture === null ? '' : `${Math.round(capture)} fps`]
        .filter(Boolean)
        .join(' · ')
    : ''

  const need = s?.symbols.need ?? null
  const have = s?.symbols.have ?? 0
  const left = eta(have, need, symbolRate(trim(progress, 5000, now)))
  stat.eta.textContent = left === null ? '—' : formatSeconds(left)

  // File row: the transfer on screen, else the kept file, else nothing.
  if (s?.meta) {
    fileNameEl.textContent = safeName(s.meta.name)
    fileSizeEl.textContent = formatBytes(s.meta.size)
    fileIdEl.textContent = s.meta.id // the same 8 hex digits as the sender's status line
  } else if (offer) {
    fileNameEl.textContent = offer.name
    fileSizeEl.textContent = formatBytes(offer.file.size)
    fileIdEl.textContent = offer.id
  } else {
    fileNameEl.textContent = 'No file yet'
    fileSizeEl.textContent = '—'
    fileIdEl.textContent = '—'
  }
  fileEl.classList.toggle('empty', !s?.meta && !offer)

  const v = view({
    scanning,
    starting,
    fatal: fatalError,
    notice,
    offer: offer && { saved: offer.saved, restored: offer.restored, at: offer.at, canShare: navigator.canShare?.({ files: [offer.file] }) ?? false },
    stats: s,
    resumed,
    workerError,
    rate,
    left,
    hint: hint(recent, video.videoHeight > video.videoWidth),
    gridSeen: recent.some((f) => f.grid),
  })

  // Progress bar, ring and tick.
  barEl.style.width = `${v.fraction * 100}%`
  progressSection.classList.toggle('done', v.complete)
  ringEl.hidden = !v.ring
  ringEl.style.setProperty('--p', `${v.fraction * 100}%`)
  ringLabel.textContent = `${Math.floor(v.fraction * 100)}%`
  ringEl.setAttribute('aria-valuenow', String(Math.floor(v.fraction * 100)))
  tickEl.hidden = !v.tick
  promptEl.hidden = !v.prompt

  // The strip: one place, four colours.
  stripEl.dataset.state = v.strip.state
  stripState.textContent = v.strip.label
  symbolsEl.textContent = v.strip.symbols
  stripExtra.textContent = v.strip.extra
  stripRight.textContent = v.strip.right

  // Buttons: always present; enabled when they can act.
  const { start, download, share, reset } = v.buttons
  startLabel.textContent = start.label
  startBtn.disabled = !start.enabled
  startBtn.classList.toggle('primary', start.primary)
  const startIcon = startBtn.querySelector('svg')
  startIcon?.classList.toggle('fill', start.label !== 'Reload') // the reload arrow is a stroke
  startIcon?.replaceChildren(pathEl(START_ICON[start.label]))
  downloadBtn.disabled = !download.enabled
  downloadBtn.classList.toggle('primary', download.primary)
  shareBtn.disabled = !share.enabled
  shareBtn.classList.toggle('primary', share.primary)
  resetBtn.disabled = !reset.enabled

  // Hint line: always 20 px; the reason a control is off, or what to change.
  hintEl.textContent = v.hint.text
  hintEl.dataset.tone = v.hint.tone
  // Status: the prompt over the camera (idle), or the one-line caption while live.
  setStatus(v.status.text, v.status.tone)
  if (DEBUG && s) debugEl.textContent = JSON.stringify({ ...s, tile_centers: undefined }, null, 1)
}

// --- camera -----------------------------------------------------------------------

/**
 * getUserMedia failures by DOMException name; any other name shows the browser's own message.
 * @type {Record<string, string>}
 */
const CAMERA_ERRORS = {
  NotAllowedError: "Camera permission denied. Allow it in Settings › Safari, or in the browser's site settings.",
  NotFoundError: 'No camera found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
  OverconstrainedError: 'This camera cannot give the requested video. Choose another one under Stats.',
}

async function startCamera() {
  if (starting || scanning || fatalError) return
  notice = null
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice = { text: 'The camera is unavailable. Open the page over HTTPS or on localhost.', tone: 'bad' }
    queueRender()
    return
  }
  if (last?.done) reset() // a finished transfer is not resumed: start a new receive
  starting = true
  queueRender()
  // stopCamera() bumps loopGen: if the decoder dies while the camera opens, the camera must not start.
  const gen = loopGen
  try {
    const opened = await openCamera(readCamera())
    if (gen !== loopGen) {
      opened.getTracks().forEach((t) => t.stop())
      return
    }
    stream = opened
    const track = stream.getVideoTracks()[0]
    settings = track?.getSettings() ?? {}
    lens = track?.label ?? ''
    // Another app or the system can take the camera (a call, the Camera app): frames just stop.
    if (track) {
      track.onended = () => cameraLost(opened)
      // iOS mutes the track for a call or when the app goes to the background: say so
      // instead of keeping Receiving over a frozen picture.
      track.onmute = () => cameraMuted(opened, true)
      track.onunmute = () => cameraMuted(opened, false)
    }
    video.srcObject = stream
    await video.play()
    if (gen !== loopGen) return // stopped meanwhile; stopCamera() released the stream
    loopGen++ // never two capture chains
    scanning = true
    viewer.classList.add('live')
    frames = []
    session = newSession()
    void keepAwake()
    void listCameras()
    schedule(loopGen)
  } catch (err) {
    if (gen !== loopGen) return // stopped meanwhile (play() is aborted): not a camera error
    stopCamera()
    const { name, message } = /** @type {Error} */ (err)
    notice = { text: CAMERA_ERRORS[name] ?? `Could not open the camera: ${message}`, tone: 'bad' }
  } finally {
    starting = false
    queueRender()
  }
}

/**
 * The chosen camera, or the default back camera. A chosen one that is gone
 * (another device, or its ID was reset) falls back to the default and is forgotten.
 * @param {string} deviceId
 */
async function openCamera(deviceId) {
  const base = { width: { ideal: CAP_WIDTH }, height: { ideal: Math.round((CAP_WIDTH * 9) / 16) }, frameRate: { ideal: 60 } }
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
 * an iPhone with several back cameras, a single lens ("Back Camera") does not
 * switch lenses by itself the way the default multi-lens camera can up close.
 */
async function listCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    const chosen = readCamera()
    cameraSelect.replaceChildren(new Option('Auto (back camera)', ''), ...cams.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)))
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

/**
 * The camera ended without this page stopping it (stop() does not fire `ended`): stop, and say
 * so, instead of a strip that keeps saying Receiving over a frozen picture.
 * @param {MediaStream} lost
 */
function cameraLost(lost) {
  if (stream !== lost) return
  stopCamera()
  notice = { text: 'The camera was taken by another app. Start again.', tone: 'bad' }
  queueRender()
}

const CAMERA_PAUSED = { text: 'The camera is paused by the system.', tone: /** @type {const} */ ('warn') }

/** @param {MediaStream} of @param {boolean} muted */
function cameraMuted(of, muted) {
  if (stream !== of) return
  if (muted) notice = CAMERA_PAUSED
  else if (notice === CAMERA_PAUSED) notice = null
  queueRender()
}

function stopCamera() {
  viewer.classList.remove('detected')
  void wakeLock?.release().catch(() => {})
  wakeLock = null
  scanning = false
  viewer.classList.remove('live')
  loopGen++
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video.srcObject = null
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
  if (notice === RESTORE_FAILED) notice = null // the file is here; nothing is left to restore
  const at = Date.now()
  show(blob, name, id, at, false)
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
  queueRender()
}

function clearOffer() {
  if (offer) URL.revokeObjectURL(offer.url)
  offer = null
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
  queueRender()
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
    if (/** @type {Error} */ (err).name !== 'AbortError') notice = { text: `Could not share: ${/** @type {Error} */ (err).message}`, tone: 'warn' }
  }
  queueRender()
}

// --- diagnostics ------------------------------------------------------------------------

/** `Copy diagnostics` (view.js picks what is copied from this snapshot). */
function snapshot() {
  const track = stream?.getVideoTracks()[0]
  return {
    app: `DiodeCam __VERSION__ (${VERSION})`,
    at: new Date().toISOString(),
    now: performance.now(),
    agent: navigator.userAgent,
    standalone: matchMedia('(display-mode: standalone)').matches,
    viewport: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    lens,
    manualCamera: readCamera() !== '',
    video: { width: video.videoWidth, height: video.videoHeight },
    scan: { width: scanCanvas.width, height: scanCanvas.height },
    settings: track?.getSettings() ?? settings,
    capabilities: track?.getCapabilities?.() ?? null,
    session,
    scanning,
    frames,
    captureTimes,
    resultTimes,
    decodeMs,
    stats: last,
  }
}

async function copyDiagnostics() {
  const text = JSON.stringify(diagnostics(snapshot()), null, 1)
  try {
    await navigator.clipboard.writeText(text)
    debugEl.hidden = !DEBUG
    copyBtn.textContent = 'Copied ✓'
  } catch {
    // No clipboard (permission, old browser): show it to copy by hand.
    debugEl.hidden = false
    debugEl.textContent = text
    copyBtn.textContent = 'Long-press the text below to copy'
  }
  setTimeout(() => (copyBtn.textContent = 'Copy diagnostics'), 3000)
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
    // store.load already checked the export, so only memory ran out: keep it for a reload.
    notice = RESTORE_FAILED
    queueRender()
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
    // Decided inside the save's own transaction, so a reset's remove cannot come between the check
    // and the write: nothing after a reset, and never a smaller export over a saved entry (one made
    // while saved tiles were being re-imported).
    const entry = { id, name: meta.name, size: meta.size, savedAt: Date.now(), data: tiles }
    if (!(await store.save(entry, { only: (stored) => gen === resetGen && store.shouldSave(stored, count) }))) return
    // The new progress replaced the entry that could not be restored.
    if (notice === RESTORE_FAILED) {
      notice = null
      queueRender()
    }
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
  viewer.classList.remove('detected')
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  queueRender()
}

// Start · Stop, or Reload once the decoder is gone (a reload resumes from the saved progress).
startBtn.addEventListener('click', () => (fatalError ? location.reload() : scanning ? (stopCamera(), queueRender()) : void startCamera()))
// Start over: the collected tiles and the kept file both go.
resetBtn.addEventListener('click', () => {
  if (offer && !offer.saved && !confirm('The received file is not saved yet. Discard it?')) return
  notice = null
  reset()
  clearOffer()
  store.dropFile().catch(() => {})
})
downloadBtn.addEventListener('click', saveFile)
shareBtn.addEventListener('click', () => void shareFile())
copyBtn.addEventListener('click', () => void copyDiagnostics())
// Sheets: native dialogs; a tap on the backdrop closes them.
/** @type {[HTMLElement, HTMLDialogElement][]} */
const sheets = [
  [$('sender-btn'), senderSheet],
  [$('stats-btn'), statsSheet],
]
for (const [btn, sheet] of sheets) {
  btn.addEventListener('click', () => sheet.showModal())
  sheet.querySelector('.close')?.addEventListener('click', () => sheet.close())
  sheet.addEventListener('click', (e) => {
    const r = sheet.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) sheet.close()
  })
}
for (const b of /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.sheet button.copy')])) {
  b.addEventListener('click', async () => {
    const text = document.getElementById(b.dataset.copy ?? '')?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      b.textContent = 'Copied'
    } catch {
      const pre = document.getElementById(b.dataset.copy ?? '')
      if (pre) getSelection()?.selectAllChildren(pre)
      b.textContent = 'Selected'
    }
    setTimeout(() => (b.textContent = 'Copy'), 2000)
  })
}
$('send-link').addEventListener('click', () => {
  const url = location.origin + location.pathname
  if (navigator.share) navigator.share({ title: 'DiodeCam', text: 'DiodeCam setup and sender downloads', url }).catch(() => {})
  else navigator.clipboard?.writeText(url).catch(() => {})
})
// Turning the phone swaps the camera's width and height: read the track's settings again, so the
// stats and diagnostics never pair the new picture with the old size. The camera is not restarted.
video.addEventListener('resize', () => {
  const track = stream?.getVideoTracks()[0]
  if (track) settings = track.getSettings()
  queueRender()
})
cameraSelect.addEventListener('change', () => {
  writeCamera(cameraSelect.value)
  if (!scanning) return
  stopCamera()
  void startCamera()
})
setInterval(queueRender, 500)
void restoreKept().then(queueRender)
render()
