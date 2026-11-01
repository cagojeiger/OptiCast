// Decoder worker: owns the WebAssembly receiver. One frame at a time; every
// frame message gets exactly one reply (result, dropped or error) so the page's
// busy flag always clears.
//
// A trap (WebAssembly.RuntimeError) leaves the instance unusable: the worker
// starts a fresh one from the compiled module it keeps, drops frames until that
// is ready, and tells the page (`restarted`) so it can re-import saved progress.
// Other errors leave the instance alone.

import wasmUrl from './wasm/opticast.wasm?url'
import type { FromWorker, ToWorker } from './protocol.ts'
import { OUT_OF_MEMORY, WasmReceiver } from './wasm.ts'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer)

let module: WebAssembly.Module | null = null
let receiver: WasmReceiver | null = null
let debug = false
let limit: number | null = null
let fileSent = false
/** Non-frame messages that arrive before the receiver exists. */
const queue: ToWorker[] = []

function configure(rx: WasmReceiver): void {
  rx.setDebug(debug)
  if (limit !== null) rx.setLimit(limit)
}

async function boot(): Promise<void> {
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error(`opticast.wasm: HTTP ${response.status}`)
  module = await WebAssembly.compile(await response.arrayBuffer())
  receiver = await WasmReceiver.fromModule(module)
  configure(receiver)
}

async function restart(): Promise<void> {
  receiver = null
  fileSent = false
  if (!module) return
  try {
    const rx = await WasmReceiver.fromModule(module)
    configure(rx)
    receiver = rx
    post({ type: 'restarted' })
    for (const msg of queue.splice(0)) handle(msg)
  } catch (err) {
    post({ type: 'error', message: `디코더를 다시 시작하지 못했습니다: ${String(err)}`, fatal: true })
  }
}

/** Reports an error; a trap also replaces the instance. */
function failed(err: unknown, id?: number): void {
  const trap = err instanceof WebAssembly.RuntimeError
  post({ type: 'error', message: `${trap ? '디코더 오류(재시작)' : '디코더 오류'}: ${String(err)}`, fatal: trap, id })
  if (trap && receiver) void restart()
}

function handle(msg: ToWorker): void {
  // Settings apply to the next instance too.
  if (msg.type === 'debug') debug = msg.on
  if (msg.type === 'limit') limit = msg.mib
  const rx = receiver
  if (!rx) {
    if (msg.type === 'frame') post({ type: 'dropped', id: msg.id })
    else if (msg.type === 'export') post({ type: 'exported', id: msg.id, bytes: new ArrayBuffer(0), tiles: 0, transferId: null })
    else queue.push(msg)
    return
  }
  try {
    switch (msg.type) {
      case 'frame': {
        const started = performance.now()
        const ok = rx.process(new Uint8Array(msg.pixels), msg.width, msg.height)
        if (ok === OUT_OF_MEMORY) {
          post({ type: 'error', message: '메모리가 부족해 프레임을 건너뜁니다', fatal: false, id: msg.id })
          return
        }
        const stats = rx.stats()
        let file: ArrayBuffer | null = null
        if (stats.done && !fileSent) {
          const data = rx.file()
          if (data) {
            file = data.buffer as ArrayBuffer
            fileSent = true
          }
        }
        post({ type: 'result', id: msg.id, capturedAt: msg.capturedAt, ms: performance.now() - started, ok, stats, file }, file ? [file] : [])
        return
      }
      case 'reset':
        rx.reset()
        fileSent = false
        return
      case 'debug':
        rx.setDebug(msg.on)
        return
      case 'limit':
        rx.setLimit(msg.mib)
        return
      case 'export': {
        const state = rx.exportState()
        const tiles = state.length >= 8 ? new DataView(state.buffer, state.byteOffset).getUint32(4) : 0
        const transferId = rx.stats().meta?.id ?? null
        post({ type: 'exported', id: msg.id, bytes: state.buffer as ArrayBuffer, tiles, transferId }, [state.buffer as ArrayBuffer])
        return
      }
      case 'import': {
        const tiles = rx.importState(new Uint8Array(msg.bytes))
        post({ type: 'imported', tiles, generation: msg.generation, stats: rx.stats() })
        return
      }
      case 'simulate-trap':
        // Same path as a real trap, for testing recovery; ignored unless debugging.
        if (debug) throw new WebAssembly.RuntimeError('simulated trap (debug)')
        return
    }
  } catch (err) {
    failed(err, msg.type === 'frame' || msg.type === 'export' ? msg.id : undefined)
    if (msg.type === 'export') post({ type: 'exported', id: msg.id, bytes: new ArrayBuffer(0), tiles: 0, transferId: null })
  }
}

scope.onmessage = ({ data }) => handle(data)

boot().then(
  () => {
    post({ type: 'ready' })
    for (const msg of queue.splice(0)) handle(msg)
  },
  (err: unknown) => post({ type: 'error', message: `디코더를 불러오지 못했습니다: ${String(err)}`, fatal: true }),
)
