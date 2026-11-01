// Receiver: camera (or a recorded video) -> QR decode in a worker -> Assembler -> verified download.
// Everything stays in the browser; nothing is uploaded.

import { Assembler, sanitizeFilename, toHex, transferIdHex, type AcceptStatus } from '../core/index.ts'
import type { ScanRequest, ScanResponse } from './scanner.worker.ts'

const params = new URLSearchParams(location.search)
/** Longest side of the image handed to the decoder; smaller is faster, larger reads denser symbols. */
const SCAN_SIZE = Number(params.get('scan') ?? 960)
/** `?denoise=0` disables the 3×3 smoothing pass, for A/B tests in the field. */
const DENOISE = params.get('denoise') !== '0'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('preview')
const overlay = $<HTMLCanvasElement>('overlay')
const statusEl = $('status')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const fileInput = $<HTMLInputElement>('file')
const resetBtn = $<HTMLButtonElement>('reset')
const progress = $<HTMLProgressElement>('progress')
const blockmap = $<HTMLCanvasElement>('blockmap')
const resultEl = $('result')
const resultText = $('result-text')
const downloadBtn = $<HTMLButtonElement>('download')

const scanCanvas = document.createElement('canvas')
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true })!
const overlayCtx = overlay.getContext('2d')!
const worker = new Worker(new URL('./scanner.worker.ts', import.meta.url), { type: 'module' })

const assembler = new Assembler()
let stream: MediaStream | null = null
let scanning = false
let busy = false
let seq = 0
let finalizing = false
let starting = false
/** Bumped by reset(), so a finalize that was in flight can tell its result is stale. */
let generation = 0
let startedAt = 0
/** Set when the last block lands; freezes the elapsed time. */
let finishedAt = 0
/** When the in-flight scan request's frame was captured (one request at a time, see `busy`). */
let capturedAt = 0
/** A worker failure stays on screen until then instead of being overwritten by the next hint. */
let warnUntil = 0
let videoUrl: string | null = null
let download: { url: string; name: string } | null = null
let renderQueued = false
const rate = { scans: 0, hits: 0, ms: 0 }

const COLORS: Record<AcceptStatus['kind'], string> = {
  block: '#3ddc97',
  meta: '#5aa9ff',
  duplicate: '#8a93a3',
  invalid: '#f2555a',
  foreign: '#f5a524',
}

/**
 * Measures the broadcast cycle from repeat sightings: a block that shows up again
 * after other frames went by has come round once more. A missed pass only makes a
 * sample longer, never shorter, so the shortest recent sample is the cycle.
 */
const cycle = { transferId: null as number | null, onScreen: null as number | null, firstAt: new Map<number, number>(), samples: [] as number[] }

function observe(status: AcceptStatus, now: number): void {
  if (cycle.transferId !== assembler.transferId) forgetCycle()
  cycle.transferId = assembler.transferId
  const key = symbolKey(status)
  if (key === null || key === cycle.onScreen) return // same symbol still on screen
  cycle.onScreen = key
  if (key < 0) return
  const prev = cycle.firstAt.get(key)
  if (prev !== undefined) {
    cycle.samples.push(now - prev)
    if (cycle.samples.length > 8) cycle.samples.shift()
  }
  cycle.firstAt.set(key, now)
}

/** Which symbol a decode showed: a block index, -1 for META, null for anything not ours. */
function symbolKey(status: AcceptStatus): number | null {
  if (status.kind === 'meta') return -1
  if (status.kind === 'block') return status.index
  if (status.kind === 'duplicate') return status.index ?? -1
  return null
}

function forgetCycle(): void {
  cycle.transferId = null
  cycle.onScreen = null
  cycle.firstAt.clear()
  cycle.samples = []
}

const cycleMs = () => (cycle.samples.length ? Math.min(...cycle.samples) : 0)

function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}초`
  const t = Math.round(s)
  if (t < 60) return `${t}초`
  return `${Math.floor(t / 60)}분 ${t % 60}초`
}

/** What to tell someone holding the phone while blocks are still missing. */
function waitHint(): string | null {
  if (!scanning || finalizing || assembler.complete || assembler.transferId === null) return null
  const missing = assembler.blockCount - assembler.received
  // DATA counts before META, so every block can be in while the file info is not.
  if (missing === 0) return '블록은 모두 받았습니다 — 파일 정보(META) 프레임을 기다리는 중. 그대로 비추세요.'
  const ms = cycleMs()
  if (!ms) return `수신 중 — 남은 블록 ${missing}개. 놓친 블록은 다음 주기에 다시 나오니 계속 비추세요.`
  return `남은 블록 ${missing}개 — 송신 화면이 ${formatDuration(ms)}마다 한 바퀴 돕니다. 그대로 비추고 기다리세요.`
}

function setStatus(text: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): void {
  statusEl.textContent = text
  statusEl.dataset.tone = tone
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

// --- capture loop -----------------------------------------------------------

function nextFrame(): void {
  if (!scanning) return
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(scan)
  else requestAnimationFrame(scan)
}

function scan(): void {
  if (!scanning) return
  if (busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
    nextFrame()
    return
  }
  const scale = Math.min(1, SCAN_SIZE / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.round(video.videoWidth * scale)
  const height = Math.round(video.videoHeight * scale)
  if (scanCanvas.width !== width || scanCanvas.height !== height) {
    scanCanvas.width = overlay.width = width
    scanCanvas.height = overlay.height = height
  }
  scanCtx.drawImage(video, 0, 0, width, height)
  const pixels = scanCtx.getImageData(0, 0, width, height).data.buffer
  busy = true
  capturedAt = performance.now()
  const request: ScanRequest = { id: ++seq, width, height, pixels, denoise: DENOISE }
  worker.postMessage(request, [pixels])
  nextFrame()
}

worker.onmessage = ({ data }: MessageEvent<ScanResponse>) => {
  busy = false
  rate.scans++
  rate.ms = rate.ms ? rate.ms * 0.9 + data.ms * 0.1 : data.ms
  if (data.error) console.warn(`decoder: ${data.error}`)
  if (!data.bytes) return
  rate.hits++
  const status = assembler.accept(data.bytes)
  if (status.kind === 'block' || status.kind === 'meta') {
    if (!startedAt) startedAt = performance.now()
  }
  observe(status, capturedAt) // capture time, so decode-time jitter stays out of the cycle estimate
  drawCorners(data.corners, COLORS[status.kind])
  queueRender()
  if (assembler.complete && !finalizing) void finalize()
}

// A crashed worker never replies; without this the loop would wait on `busy` forever.
function onWorkerFailure(event: Event): void {
  busy = false
  console.error('decoder worker error', event)
  warnUntil = performance.now() + 3000
  setStatus('디코더 오류가 발생했습니다. 계속 시도합니다.', 'warn')
}
worker.onerror = onWorkerFailure
worker.onmessageerror = onWorkerFailure

let overlayTimer = 0
function drawCorners(corners: number[] | null, color: string): void {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  if (!corners) return
  overlayCtx.strokeStyle = color
  overlayCtx.lineWidth = Math.max(3, overlay.width / 160)
  overlayCtx.beginPath()
  for (let i = 0; i < 4; i++) overlayCtx.lineTo(corners[i * 2]!, corners[i * 2 + 1]!)
  overlayCtx.closePath()
  overlayCtx.stroke()
  clearTimeout(overlayTimer)
  overlayTimer = window.setTimeout(() => overlayCtx.clearRect(0, 0, overlay.width, overlay.height), 400)
}

function startScanning(): void {
  scanning = true
  startBtn.hidden = true
  stopBtn.hidden = false
  nextFrame()
}

function stopScanning(): void {
  scanning = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  video.pause()
  startBtn.hidden = false
  stopBtn.hidden = true
}

// --- sources ----------------------------------------------------------------

/** A finished (or failed) transfer is not resumable: a new source starts a new receive. */
function resetIfFinished(): void {
  if (assembler.complete || finalizing) reset()
}

function releaseVideoUrl(): void {
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = null
}

async function startCamera(): Promise<void> {
  if (starting) return
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('카메라를 쓸 수 없습니다. HTTPS 또는 localhost로 접속했는지 확인하세요.', 'bad')
    return
  }
  starting = true
  startBtn.disabled = true
  try {
    let next: MediaStream
    try {
      next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
    } catch (err) {
      setStatus(`카메라 권한을 얻지 못했습니다: ${(err as Error).message}`, 'bad')
      return
    }
    stopScanning() // releases any previous stream before we replace it
    resetIfFinished()
    forgetCycle() // a new source runs on a new clock
    releaseVideoUrl()
    stream = next
    const [track] = stream.getVideoTracks()
    const caps = track?.getCapabilities?.() as { focusMode?: string[] } | undefined
    if (track && caps?.focusMode?.includes('continuous')) {
      void track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
    }
    video.onended = null
    video.removeAttribute('src')
    video.srcObject = stream
    await video.play()
    setStatus('송신 화면을 비추세요. 순서와 상관없이 블록을 모읍니다.')
    startScanning()
  } catch (err) {
    stopScanning()
    setStatus(`카메라 영상을 재생하지 못했습니다: ${(err as Error).message}`, 'bad')
  } finally {
    starting = false
    startBtn.disabled = false
  }
}

async function openVideo(file: File): Promise<void> {
  stopScanning()
  resetIfFinished()
  forgetCycle() // a new source runs on a new clock
  releaseVideoUrl()
  video.srcObject = null
  videoUrl = URL.createObjectURL(file)
  video.src = videoUrl
  video.playbackRate = Number(params.get('rate') ?? 1)
  video.onended = () => {
    scanning = false
    startBtn.hidden = false
    stopBtn.hidden = true
    if (!assembler.complete) setStatus(`영상이 끝났습니다. 블록 ${assembler.received}/${assembler.blockCount || '?'} 수신.`, 'warn')
  }
  try {
    await video.play()
  } catch (err) {
    setStatus(`동영상을 재생하지 못했습니다: ${(err as Error).message}`, 'bad')
    return
  }
  setStatus(`동영상 분석 중: ${file.name}`)
  startScanning()
}

// --- completion ---------------------------------------------------------------

async function finalize(): Promise<void> {
  finalizing = true
  finishedAt = performance.now()
  const mine = generation
  setStatus('모든 블록 수신. SHA-256 검증 중…')
  try {
    const { envelope, data } = await assembler.finalize()
    if (mine !== generation) return // reset while verifying: this result belongs to the old transfer
    stopScanning()
    const seconds = ((finishedAt - startedAt) / 1000).toFixed(1)
    const name = sanitizeFilename(envelope.filename)
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: envelope.mime || 'application/octet-stream' })
    if (download) URL.revokeObjectURL(download.url)
    download = { url: URL.createObjectURL(blob), name }
    resultEl.hidden = false
    resultEl.dataset.tone = 'ok'
    downloadBtn.hidden = false
    resultText.textContent = `✓ 검증 완료 — ${name} (${formatBytes(data.length)}), ${seconds}초. SHA-256 ${toHex(envelope.sha256).slice(0, 16)}…`
    setStatus('복원 완료. 파일을 저장하세요.', 'ok')
  } catch (err) {
    if (mine !== generation) return
    stopScanning()
    resultEl.hidden = false
    resultEl.dataset.tone = 'bad'
    downloadBtn.hidden = true
    resultText.textContent = `복원 실패: ${(err as Error).message}. 초기화 후 다시 수신하세요.`
    setStatus('검증 실패 — 파일을 저장하지 않았습니다.', 'bad')
  }
}

function saveFile(): void {
  if (!download) return
  const a = document.createElement('a')
  a.href = download.url
  a.download = download.name
  a.click()
}

function reset(): void {
  generation++
  assembler.reset()
  forgetCycle()
  finalizing = false
  startedAt = 0
  finishedAt = 0
  if (download) URL.revokeObjectURL(download.url)
  download = null
  resultEl.hidden = true
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
  setStatus(scanning ? '초기화했습니다. 계속 수신 중.' : '카메라를 시작하고 송신 화면을 비추세요.')
  queueRender()
}

// --- rendering ------------------------------------------------------------------

function queueRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

function render(): void {
  const { envelope, stats, blockCount, received } = assembler
  $('transfer-id').textContent = assembler.transferId === null ? '—' : transferIdHex(assembler.transferId)
  $('filename').textContent = envelope ? sanitizeFilename(envelope.filename) : assembler.transferId === null ? '—' : 'META 대기 중'
  $('size').textContent = envelope ? formatBytes(envelope.size) : '—'
  $('blocks').textContent = `${received} / ${blockCount || '?'}`
  progress.value = blockCount ? received / blockCount : 0
  $('stat-dup').textContent = String(stats.duplicates)
  $('stat-bad').textContent = String(stats.invalid)
  $('stat-foreign').textContent = String(stats.foreign)
  // A decode still in flight at stop or video end must not replace that message.
  if (scanning && performance.now() >= warnUntil) {
    if (stats.foreign > 0 && !assembler.complete) {
      setStatus('다른 전송의 프레임이 보입니다. 송신 화면이 바뀌었다면 초기화하세요.', 'warn')
    } else {
      const hint = waitHint()
      if (hint) setStatus(hint)
    }
  }
  drawBlockmap()
}

function drawBlockmap(): void {
  const n = assembler.blockCount
  const width = blockmap.clientWidth * devicePixelRatio
  const height = blockmap.clientHeight * devicePixelRatio
  blockmap.width = width
  blockmap.height = height
  const ctx = blockmap.getContext('2d')!
  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, 0, width, height)
  if (!n) return
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * width) / height)))
  const rows = Math.ceil(n / cols)
  const cw = width / cols
  const ch = height / rows
  const gap = cw > 6 && ch > 6 ? 1 : 0
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = assembler.has(i) ? '#3ddc97' : '#262c36'
    ctx.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, cw - gap, ch - gap)
  }
}

setInterval(() => {
  $('stat-scan').textContent = `${rate.scans}/s`
  $('stat-hit').textContent = `${rate.hits}/s`
  $('stat-ms').textContent = rate.ms ? `${rate.ms.toFixed(0)} ms` : '— ms'
  $('stat-cycle').textContent = cycleMs() ? formatDuration(cycleMs()) : '—'
  // Frozen when the last block lands or the source stops; reset() clears it.
  if (!startedAt) $('stat-elapsed').textContent = '—'
  else if (scanning || finishedAt) $('stat-elapsed').textContent = formatDuration((finishedAt || performance.now()) - startedAt)
  rate.scans = 0
  rate.hits = 0
}, 1000)

startBtn.onclick = () => void startCamera()
stopBtn.onclick = () => {
  stopScanning()
  setStatus('정지했습니다. 받은 블록은 유지됩니다.')
}
fileInput.onchange = () => {
  const file = fileInput.files?.[0]
  if (file) void openVideo(file)
  fileInput.value = ''
}
resetBtn.onclick = reset
downloadBtn.onclick = saveFile
render()
