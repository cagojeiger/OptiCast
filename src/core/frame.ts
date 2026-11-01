// Framing layer: one frame = one optical symbol (one QR code in v0).
//
//   offset size field
//   0      2    magic "OC" (0x4F 0x43)
//   2      1    protocol version
//   3      1    frame type (0 = META, 1 = DATA)
//   4      4    transfer id (crc32 of the envelope bytes)
//   8      2    block index (DATA) / 0 (META)
//   10     2    block count (number of DATA blocks in the transfer)
//   12     2    payload length
//   14     n    payload
//   14+n   4    crc32 over bytes [0, 14+n)
//
// All integers are big-endian. The CRC rejects partially redrawn screens and
// QR codes that are not ours, on top of the optical layer's own ECC.

import { crc32 } from './crc32.ts'

export const MAGIC_0 = 0x4f
export const MAGIC_1 = 0x43
export const PROTOCOL_VERSION = 1
export const HEADER_SIZE = 14
export const CRC_SIZE = 4
export const FRAME_OVERHEAD = HEADER_SIZE + CRC_SIZE
export const MAX_BLOCKS = 0xffff

export const FrameType = { Meta: 0, Data: 1 } as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export interface Frame {
  type: FrameType
  transferId: number
  index: number
  count: number
  payload: Uint8Array
}

export type DecodeFailure = 'short' | 'magic' | 'version' | 'type' | 'length' | 'crc'
export type DecodeResult = { ok: true; frame: Frame } | { ok: false; reason: DecodeFailure }

export function encodeFrame(frame: Frame): Uint8Array {
  const { payload } = frame
  if (payload.length > 0xffff) throw new RangeError('payload too large for one frame')
  const out = new Uint8Array(FRAME_OVERHEAD + payload.length)
  const view = new DataView(out.buffer)
  out[0] = MAGIC_0
  out[1] = MAGIC_1
  out[2] = PROTOCOL_VERSION
  out[3] = frame.type
  view.setUint32(4, frame.transferId >>> 0)
  view.setUint16(8, frame.index)
  view.setUint16(10, frame.count)
  view.setUint16(12, payload.length)
  out.set(payload, HEADER_SIZE)
  view.setUint32(HEADER_SIZE + payload.length, crc32(out.subarray(0, HEADER_SIZE + payload.length)))
  return out
}

export function decodeFrame(bytes: Uint8Array): DecodeResult {
  if (bytes.length < FRAME_OVERHEAD) return { ok: false, reason: 'short' }
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) return { ok: false, reason: 'magic' }
  if (bytes[2] !== PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  const type = bytes[3]
  if (type !== FrameType.Meta && type !== FrameType.Data) return { ok: false, reason: 'type' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint16(12)
  if (bytes.length < FRAME_OVERHEAD + length) return { ok: false, reason: 'length' }
  const body = bytes.subarray(0, HEADER_SIZE + length)
  if (view.getUint32(HEADER_SIZE + length) !== crc32(body)) return { ok: false, reason: 'crc' }
  return {
    ok: true,
    frame: {
      type,
      transferId: view.getUint32(4),
      index: view.getUint16(8),
      count: view.getUint16(10),
      payload: bytes.slice(HEADER_SIZE, HEADER_SIZE + length),
    },
  }
}
