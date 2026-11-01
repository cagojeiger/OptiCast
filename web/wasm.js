// @ts-check
// The receiver's WebAssembly module (crates/diodecam-wasm) behind a small class.
// Plain C ABI: no generated bindings. Works in a Worker and in Node.

/**
 * What `receiver_stats` reports after each frame (docs/web.md).
 * @typedef {object} ReceiverStats
 * @property {number} frames
 * @property {boolean} detected
 * @property {{ w: number, h: number, profile: 'ssh' | 'vt100' } | null} grid
 * @property {(number | null)[] | null} corners Grid corners in scan pixels: tl, tr, br, bl as x, y pairs (null for a non-finite value).
 * @property {(number | null)[]} [finders] Finder centres tl, tr, br, bl.
 * @property {'normal' | 'inverted'} [polarity]
 * @property {boolean} [tracked]
 * @property {number | null} [residual]
 * @property {boolean} [corrected]
 * @property {{ ok: number, total: number }} tiles This frame.
 * @property {{ frames: number, detections: number, tiles_ok: number, tiles: number }} totals
 * @property {{ have: number, need: number | null }} symbols
 * @property {{ name: string, size: number, id: string, compression: string } | null} meta File name is already sanitized for display and download.
 * @property {number} limit Largest file accepted, in bytes.
 * @property {{ id: string, size: number } | null} too_large The last META refused for exceeding `limit`.
 * @property {number} too_large_count
 * @property {number} foreign
 * @property {number} duplicates
 * @property {number} invalid
 * @property {number} failed
 * @property {boolean} done
 * @property {string | null} error
 * @property {number} kept
 * @property {string} tile_status One character per tile position of this frame: '1' passed, '0' failed.
 * @property {(number | null)[]} [tile_centers] With debug on: tile centres in scan pixels.
 */

/**
 * @typedef {object} Exports
 * @property {WebAssembly.Memory} memory
 * @property {(len: number) => number} alloc
 * @property {(ptr: number, len: number) => void} dealloc
 * @property {() => number} last_len
 * @property {() => number} receiver_new
 * @property {(handle: number) => void} receiver_reset
 * @property {(handle: number, on: number) => void} receiver_set_debug
 * @property {(handle: number, mib: number) => void} receiver_set_limit
 * @property {(handle: number, ptr: number, len: number, width: number, height: number) => number} receiver_process
 * @property {(handle: number) => number} receiver_stats
 * @property {(handle: number) => number} receiver_file
 * @property {(handle: number) => number} receiver_export
 * @property {(handle: number, ptr: number, len: number) => number} receiver_import
 */

/** `process()` result when wasm memory for the frame could not be allocated. */
export const OUT_OF_MEMORY = -3

export class WasmReceiver {
  /** @param {Exports} ex */
  constructor(ex) {
    this.ex = ex
    this.handle = ex.receiver_new()
    if (!this.handle) throw new Error('receiver_new failed')
    /** Reused wasm-side input buffer. */
    this.buffer = 0
    this.capacity = 0
  }

  /**
   * Compiles and instantiates the module bytes (not streaming: works whatever MIME type the server sends).
   * @param {BufferSource} bytes
   */
  static async create(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {})
    return new WasmReceiver(/** @type {Exports} */ (instance.exports))
  }

  /**
   * One RGBA frame. Returns tiles that passed, −1 when no grid was found, −2 for
   * a buffer that does not match the size, −3 when no wasm memory was available
   * for the frame (it is skipped).
   * @param {Uint8Array | Uint8ClampedArray} rgba
   * @param {number} width
   * @param {number} height
   */
  process(rgba, width, height) {
    const ptr = this.reserve(rgba.length)
    if (!ptr) return OUT_OF_MEMORY
    new Uint8Array(this.ex.memory.buffer, ptr, rgba.length).set(rgba)
    return this.ex.receiver_process(this.handle, ptr, rgba.length, width, height)
  }

  /** @returns {ReceiverStats} */
  stats() {
    return JSON.parse(new TextDecoder().decode(this.view(this.ex.receiver_stats(this.handle))))
  }

  /** The verified file, once done. */
  file() {
    const ptr = this.ex.receiver_file(this.handle)
    return ptr ? this.view(ptr).slice() : null
  }

  /** Collected tiles, to resume after a reload. */
  exportState() {
    return this.view(this.ex.receiver_export(this.handle)).slice()
  }

  /**
   * Feeds an export back in; returns tiles read or −1 (not an export, or no memory).
   * @param {Uint8Array} bytes
   */
  importState(bytes) {
    const ptr = this.reserve(bytes.length)
    if (!ptr) return -1
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes)
    return this.ex.receiver_import(this.handle, ptr, bytes.length)
  }

  reset() {
    this.ex.receiver_reset(this.handle)
  }

  /** @param {boolean} on */
  setDebug(on) {
    this.ex.receiver_set_debug(this.handle, on ? 1 : 0)
  }

  /**
   * Largest file accepted, in MiB (the module clamps it to 1–1024).
   * @param {number} mib
   */
  setLimit(mib) {
    this.ex.receiver_set_limit(this.handle, mib)
  }

  /**
   * View of `last_len()` bytes at `ptr` (memory may grow, so views are made fresh).
   * @param {number} ptr
   */
  view(ptr) {
    return new Uint8Array(this.ex.memory.buffer, ptr, this.ex.last_len())
  }

  /**
   * A wasm-side input buffer of at least `len` bytes, reused between frames;
   * 0 if it cannot be had (then nothing is recorded, so the next call tries again).
   * @param {number} len
   */
  reserve(len) {
    if (len <= this.capacity) return this.buffer
    if (this.buffer) this.ex.dealloc(this.buffer, this.capacity)
    this.buffer = 0
    this.capacity = 0
    const ptr = this.ex.alloc(len)
    if (!ptr) return 0
    this.buffer = ptr
    this.capacity = len
    return ptr
  }
}
