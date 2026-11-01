// Messages between the page and the decoder worker.

import type { ReceiverStats } from './wasm.ts'

export type ToWorker =
  | { type: 'frame'; id: number; width: number; height: number; pixels: ArrayBuffer; capturedAt: number }
  | { type: 'reset' }
  | { type: 'debug'; on: boolean }
  | { type: 'limit'; mib: number }
  | { type: 'export'; id: number }
  | { type: 'import'; bytes: ArrayBuffer; generation: number }
  /** Debug builds of the page only (`?debug=1`): exercise trap recovery. */
  | { type: 'simulate-trap' }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'result'; id: number; capturedAt: number; ms: number; ok: number; stats: ReceiverStats; file: ArrayBuffer | null }
  /** The frame was not processed (decoder starting or restarting). */
  | { type: 'dropped'; id: number }
  | { type: 'exported'; id: number; bytes: ArrayBuffer; tiles: number; transferId: string | null }
  | { type: 'imported'; tiles: number; generation: number; stats: ReceiverStats }
  /** The instance trapped and was replaced: collected tiles are gone until re-imported. */
  | { type: 'restarted' }
  /** `id` is set when the error ends the processing of that frame. */
  | { type: 'error'; message: string; fatal: boolean; id?: number }
