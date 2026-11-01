// The receiver's WebAssembly module (crates/opticast-wasm) behind a small class.
// Plain C ABI: no generated bindings. Works in a Worker and in Node.

/** What `receiver_stats` reports after each frame. */
export interface ReceiverStats {
  frames: number
  detected: boolean
  grid: { w: number; h: number; profile: 'ssh' | 'vt100' } | null
  /** Grid corners in scan pixels: tl, tr, br, bl as x, y pairs (null for a non-finite value). */
  corners: (number | null)[] | null
  /** Finder centres tl, tr, br, bl. */
  finders?: (number | null)[]
  polarity?: 'normal' | 'inverted'
  tracked?: boolean
  residual?: number | null
  corrected?: boolean
  /** This frame. */
  tiles: { ok: number; total: number }
  totals: { frames: number; detections: number; tiles_ok: number; tiles: number }
  symbols: { have: number; need: number | null }
  /** File name is already sanitized for display and download. */
  meta: { name: string; size: number; id: string; compression: string } | null
  /** Largest file accepted, in bytes. */
  limit: number
  /** The last META refused for exceeding `limit`. */
  too_large: { id: string; size: number } | null
  too_large_count: number
  foreign: number
  duplicates: number
  invalid: number
  failed: number
  done: boolean
  error: string | null
  kept: number
  /** One character per tile position of this frame: '1' passed, '0' failed. */
  tile_status: string
  /** With debug on: tile centres in scan pixels. */
  tile_centers?: (number | null)[]
}

interface Exports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  last_len(): number
  receiver_new(): number
  receiver_free(handle: number): void
  receiver_reset(handle: number): void
  receiver_set_debug(handle: number, on: number): void
  receiver_set_limit(handle: number, mib: number): void
  receiver_process(handle: number, ptr: number, len: number, width: number, height: number): number
  receiver_stats(handle: number): number
  receiver_file(handle: number): number
  receiver_export(handle: number): number
  receiver_import(handle: number, ptr: number, len: number): number
}

/** `process()` result when wasm memory for the frame could not be allocated. */
export const OUT_OF_MEMORY = -3

export class WasmReceiver {
  private readonly ex: Exports
  private readonly handle: number
  private buffer = 0
  private capacity = 0

  private constructor(ex: Exports) {
    this.ex = ex
    this.handle = ex.receiver_new()
    if (!this.handle) throw new Error('receiver_new failed')
  }

  /** Compiles and instantiates the module bytes (not streaming: works whatever MIME type the server sends). */
  static async create(bytes: BufferSource): Promise<WasmReceiver> {
    return WasmReceiver.fromModule(await WebAssembly.compile(bytes))
  }

  /** A fresh instance of an already compiled module (cheap: used to recover from a trap). */
  static async fromModule(module: WebAssembly.Module): Promise<WasmReceiver> {
    const instance = await WebAssembly.instantiate(module, {})
    return new WasmReceiver(instance.exports as unknown as Exports)
  }

  /**
   * One RGBA frame. Returns tiles that passed, −1 when no grid was found, −2 for
   * a buffer that does not match the size, −3 when no wasm memory was available
   * for the frame (it is skipped).
   */
  process(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): number {
    const ptr = this.reserve(rgba.length)
    if (!ptr) return OUT_OF_MEMORY
    new Uint8Array(this.ex.memory.buffer, ptr, rgba.length).set(rgba)
    return this.ex.receiver_process(this.handle, ptr, rgba.length, width, height)
  }

  stats(): ReceiverStats {
    const ptr = this.ex.receiver_stats(this.handle)
    return JSON.parse(new TextDecoder().decode(this.view(ptr))) as ReceiverStats
  }

  /** The verified file, once done. */
  file(): Uint8Array | null {
    const ptr = this.ex.receiver_file(this.handle)
    return ptr ? this.view(ptr).slice() : null
  }

  /** Collected tiles, to resume after a reload. */
  exportState(): Uint8Array {
    return this.view(this.ex.receiver_export(this.handle)).slice()
  }

  /** Feeds an export back in; returns tiles read or −1 (not an export, or no memory). */
  importState(bytes: Uint8Array): number {
    const ptr = this.reserve(bytes.length)
    if (!ptr) return -1
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes)
    return this.ex.receiver_import(this.handle, ptr, bytes.length)
  }

  reset(): void {
    this.ex.receiver_reset(this.handle)
  }

  setDebug(on: boolean): void {
    this.ex.receiver_set_debug(this.handle, on ? 1 : 0)
  }

  /** Largest file accepted, in MiB (the module clamps it to 1–1024). */
  setLimit(mib: number): void {
    this.ex.receiver_set_limit(this.handle, mib)
  }

  /** Copy of `last_len()` bytes at `ptr` (memory may grow, so views are made fresh). */
  private view(ptr: number): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer, ptr, this.ex.last_len())
  }

  /**
   * A wasm-side input buffer of at least `len` bytes, reused between frames;
   * 0 if it cannot be had (then nothing is recorded, so the next call tries again).
   */
  private reserve(len: number): number {
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
