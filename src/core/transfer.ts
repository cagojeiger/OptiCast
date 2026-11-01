// Transfer layer: file bytes <-> one broadcast cycle of frames.
//
// The sender repeats the cycle forever (F(t+T) = F(t)); there is no ACK or
// handshake. The receiver can join at any point, accepts frames in any order,
// drops duplicates, and fills gaps from later cycles. Completion requires every
// block plus a matching SHA-256 of the restored original.

import { concat, deflate, equalBytes, inflate, sha256 } from './bytes.ts'
import { crc32 } from './crc32.ts'
import {
  Compression,
  decodeEnvelope,
  encodeEnvelope,
  ENVELOPE_FIXED_SIZE,
  truncateFilename,
  type Envelope,
} from './envelope.ts'
import { decodeFrame, encodeFrame, FrameType, MAX_BLOCKS, type DecodeFailure } from './frame.ts'

const encoder = new TextEncoder()

export const DEFAULT_META_EVERY = 10
export const DEFAULT_RECEIVE_LIMIT = 64 * 1024 * 1024

export interface PrepareOptions {
  filename: string
  mime?: string
  /** Payload bytes per DATA frame (the optical frame capacity minus FRAME_OVERHEAD). */
  blockSize: number
  /** 'auto' deflates only when that makes the data smaller. */
  compress?: 'auto' | 'never'
  /** A META frame is inserted before every N-th DATA frame. */
  metaEvery?: number
}

export interface PreparedTransfer {
  envelope: Envelope
  transferId: number
  blockCount: number
  /** One broadcast cycle in display order. Repeat it forever. */
  cycle: Uint8Array[]
}

export async function prepareTransfer(data: Uint8Array, opts: PrepareOptions): Promise<PreparedTransfer> {
  const { blockSize, metaEvery = DEFAULT_META_EVERY } = opts
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 0xffff) {
    throw new RangeError(`invalid block size: ${blockSize}`)
  }
  if (!Number.isInteger(metaEvery) || metaEvery < 1) throw new RangeError(`invalid metaEvery: ${metaEvery}`)

  // META must fit in one frame, so mime and filename share what the fixed fields leave.
  let mime = opts.mime ?? 'application/octet-stream'
  if (ENVELOPE_FIXED_SIZE + encoder.encode(mime).length + 1 > blockSize) mime = ''
  const nameBudget = Math.min(255, blockSize - ENVELOPE_FIXED_SIZE - encoder.encode(mime).length)
  if (nameBudget < 1) {
    throw new RangeError(`block size ${blockSize} cannot hold the envelope; use a larger optical frame`)
  }
  const filename = truncateFilename(opts.filename, nameBudget)

  let encoded = data
  let compression: Compression = Compression.None
  if (opts.compress !== 'never') {
    const packed = await deflate(data)
    if (packed.length < data.length) {
      encoded = packed
      compression = Compression.Deflate
    }
  }

  const blockCount = Math.max(1, Math.ceil(encoded.length / blockSize))
  if (blockCount > MAX_BLOCKS) {
    throw new RangeError(`${blockCount} blocks exceed the ${MAX_BLOCKS}-block limit; use a larger optical frame`)
  }

  const envelope: Envelope = {
    size: data.length,
    encodedSize: encoded.length,
    blockSize,
    compression,
    sha256: await sha256(data),
    mime,
    filename,
  }
  const envelopeBytes = encodeEnvelope(envelope)
  // Derived from the envelope, so it changes with content *and* framing parameters:
  // a receiver never mixes blocks from two incompatible broadcasts.
  const transferId = crc32(envelopeBytes)
  const meta = encodeFrame({ type: FrameType.Meta, transferId, index: 0, count: blockCount, payload: envelopeBytes })

  const cycle: Uint8Array[] = []
  for (let i = 0; i < blockCount; i++) {
    if (i % metaEvery === 0) cycle.push(meta)
    const payload = encoded.subarray(i * blockSize, (i + 1) * blockSize)
    cycle.push(encodeFrame({ type: FrameType.Data, transferId, index: i, count: blockCount, payload }))
  }
  return { envelope, transferId, blockCount, cycle }
}

export type RejectReason = DecodeFailure | 'envelope' | 'index' | 'length'

export type AcceptStatus =
  | { kind: 'invalid'; reason: RejectReason }
  | { kind: 'foreign'; transferId: number }
  | { kind: 'duplicate'; index?: number } // index set for DATA repeats, absent for META
  | { kind: 'meta' }
  | { kind: 'block'; index: number }

export interface AssemblerStats {
  newBlocks: number
  duplicates: number
  invalid: number
  foreign: number
}

export interface AssembledFile {
  envelope: Envelope
  data: Uint8Array
}

export class Assembler {
  transferId: number | null = null
  blockCount = 0
  envelope: Envelope | null = null
  received = 0
  stats: AssemblerStats = { newBlocks: 0, duplicates: 0, invalid: 0, foreign: 0 }
  private blocks: (Uint8Array | undefined)[] = []

  get complete(): boolean {
    return this.envelope !== null && this.received === this.blockCount
  }

  has(index: number): boolean {
    return this.blocks[index] !== undefined
  }

  reset(): void {
    this.transferId = null
    this.blockCount = 0
    this.envelope = null
    this.received = 0
    this.stats = { newBlocks: 0, duplicates: 0, invalid: 0, foreign: 0 }
    this.blocks = []
  }

  /** Feed raw bytes of one decoded optical symbol. Never throws. */
  accept(raw: Uint8Array): AcceptStatus {
    const result = decodeFrame(raw)
    if (!result.ok) return this.reject(result.reason)
    const frame = result.frame
    if (frame.count < 1 || (frame.type === FrameType.Meta ? frame.index !== 0 : frame.index >= frame.count)) {
      return this.reject('index')
    }

    let envelope: Envelope | null = null
    if (frame.type === FrameType.Meta) {
      if (this.envelope && frame.transferId === this.transferId) return this.duplicate()
      envelope = decodeEnvelope(frame.payload)
      if (!envelope || crc32(frame.payload) !== frame.transferId || !isConsistent(envelope, frame.count)) {
        return this.reject('envelope')
      }
    }

    // A lock taken from DATA alone is provisional (it may be a stale frame from an
    // earlier broadcast); a verified META confirms it or replaces it. Once
    // confirmed, other transfers are only reported, never mixed in.
    const replace = envelope !== null && this.envelope === null && frame.transferId !== this.transferId
    if (this.transferId === null || replace) {
      this.lock(frame.transferId, frame.count)
    } else if (frame.transferId !== this.transferId || frame.count !== this.blockCount) {
      this.stats.foreign++
      return { kind: 'foreign', transferId: frame.transferId }
    }

    if (envelope) {
      this.envelope = envelope
      // Blocks that arrived before META could not be length-checked until now.
      this.blocks.forEach((block, i) => {
        if (block && block.length !== this.expectedLength(i)) {
          this.blocks[i] = undefined
          this.received--
        }
      })
      return { kind: 'meta' }
    }

    if (this.envelope && frame.payload.length !== this.expectedLength(frame.index)) return this.reject('length')
    if (this.blocks[frame.index]) return this.duplicate(frame.index)
    this.blocks[frame.index] = frame.payload
    this.received++
    this.stats.newBlocks++
    return { kind: 'block', index: frame.index }
  }

  /** Reassemble, decompress and verify. Resolves only for a byte-exact original. */
  async finalize(limit = DEFAULT_RECEIVE_LIMIT): Promise<AssembledFile> {
    const envelope = this.envelope
    if (!envelope || !this.complete) throw new Error('transfer is not complete')
    if (envelope.size > limit) throw new Error(`file is ${envelope.size} bytes, over the ${limit}-byte limit`)

    const blocks = this.blocks as Uint8Array[]
    blocks.forEach((block, i) => {
      const expected = this.expectedLength(i)
      if (block.length !== expected) throw new Error(`block ${i} has ${block.length} bytes, expected ${expected}`)
    })
    const encoded = concat(blocks)
    const data = envelope.compression === Compression.Deflate ? await inflate(encoded, envelope.size) : encoded
    if (data.length !== envelope.size) throw new Error(`restored ${data.length} bytes, expected ${envelope.size}`)
    if (!equalBytes(await sha256(data), envelope.sha256)) throw new Error('SHA-256 mismatch')
    return { envelope, data }
  }

  private lock(transferId: number, count: number): void {
    this.transferId = transferId
    this.blockCount = count
    this.blocks = new Array(count)
    this.received = 0
    this.stats.foreign = 0
  }

  private expectedLength(index: number): number {
    const env = this.envelope!
    return index < this.blockCount - 1 ? env.blockSize : env.encodedSize - index * env.blockSize
  }

  private reject(reason: RejectReason): AcceptStatus {
    this.stats.invalid++
    return { kind: 'invalid', reason }
  }

  private duplicate(index?: number): AcceptStatus {
    this.stats.duplicates++
    return index === undefined ? { kind: 'duplicate' } : { kind: 'duplicate', index }
  }
}

function isConsistent(env: Envelope, count: number): boolean {
  if (env.blockSize < 1) return false
  if (count !== Math.max(1, Math.ceil(env.encodedSize / env.blockSize))) return false
  if (env.compression === Compression.None && env.encodedSize !== env.size) return false
  return true
}
