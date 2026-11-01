// @ts-check
// Decoder worker: owns the WebAssembly receiver. One frame at a time; every
// frame message gets exactly one reply (result or error) so the page's busy
// flag always clears. Messages that arrive while the module loads are queued.
// Any exception (a wasm trap leaves the instance unusable) is fatal: the page
// stops and a reload resumes from the progress saved in IndexedDB.

import { OUT_OF_MEMORY, WasmReceiver } from './wasm.js?v=__V__'

/** @import { ReceiverStats } from './wasm.js' */

/**
 * Page → worker.
 * @typedef {{ type: 'frame', width: number, height: number, pixels: ArrayBuffer, capturedAt: number }
 *   | { type: 'reset' }
 *   | { type: 'debug', on: boolean }
 *   | { type: 'limit', mib: number }
 *   | { type: 'export' }
 *   | { type: 'import', bytes: ArrayBuffer, generation: number }} ToWorker
 */

/**
 * Worker → page.
 * @typedef {{ type: 'result', capturedAt: number, ms: number, stats: ReceiverStats, file: ArrayBuffer | null }
 *   | { type: 'exported', bytes: ArrayBuffer, tiles: number, transferId: string | null }
 *   | { type: 'imported', tiles: number, generation: number, stats: ReceiverStats }
 *   | { type: 'error', message: string, fatal: boolean }} FromWorker
 */

/**
 * @param {FromWorker} msg
 * @param {Transferable[]} [transfer]
 */
const post = (msg, transfer = []) => /** @type {any} */ (self).postMessage(msg, transfer)

/** @type {WasmReceiver | null} */
let receiver = null
let fileSent = false
/** @type {ToWorker[]} */
const queue = []

/** @param {ToWorker} msg */
function handle(msg) {
  const rx = receiver
  if (!rx) {
    queue.push(msg)
    return
  }
  try {
    switch (msg.type) {
      case 'frame': {
        const started = performance.now()
        if (rx.process(new Uint8Array(msg.pixels), msg.width, msg.height) === OUT_OF_MEMORY) {
          post({ type: 'error', message: '메모리가 부족해 프레임을 건너뜁니다', fatal: false })
          return
        }
        const stats = rx.stats()
        /** @type {ArrayBuffer | null} */
        let file = null
        if (stats.done && !fileSent) {
          file = /** @type {ArrayBuffer | null} */ (rx.file()?.buffer ?? null)
          fileSent = file !== null
        }
        post({ type: 'result', capturedAt: msg.capturedAt, ms: performance.now() - started, stats, file }, file ? [file] : [])
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
        const tiles = state.length >= 8 ? new DataView(state.buffer).getUint32(4) : 0
        const bytes = /** @type {ArrayBuffer} */ (state.buffer)
        post({ type: 'exported', bytes, tiles, transferId: rx.stats().meta?.id ?? null }, [bytes])
        return
      }
      case 'import': {
        const tiles = rx.importState(new Uint8Array(msg.bytes))
        post({ type: 'imported', tiles, generation: msg.generation, stats: rx.stats() })
        return
      }
    }
  } catch (err) {
    post({ type: 'error', message: String(err), fatal: true })
  }
}

self.onmessage = ({ data }) => handle(data)

async function boot() {
  const response = await fetch(new URL('./diodecam.wasm?v=__V__', import.meta.url))
  if (!response.ok) throw new Error(`diodecam.wasm: HTTP ${response.status}`)
  receiver = await WasmReceiver.create(await response.arrayBuffer())
  for (const msg of queue.splice(0)) handle(msg)
}

boot().catch((err) => post({ type: 'error', message: String(err), fatal: true }))
