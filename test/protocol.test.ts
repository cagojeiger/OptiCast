import { describe, expect, it } from 'vitest'
import {
  Compression,
  crc32,
  decodeEnvelope,
  decodeFrame,
  encodeEnvelope,
  encodeFrame,
  FRAME_OVERHEAD,
  FrameType,
  sanitizeFilename,
  truncateFilename,
  type Envelope,
} from '../src/core/index.ts'

const encoder = new TextEncoder()

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('frame', () => {
  const frame = { type: FrameType.Data, transferId: 0xdeadbeef, index: 513, count: 1024, payload: encoder.encode('hello, optical world') }

  it('round-trips', () => {
    const bytes = encodeFrame(frame)
    expect(bytes.length).toBe(FRAME_OVERHEAD + frame.payload.length)
    const result = decodeFrame(bytes)
    expect(result.ok && result.frame).toEqual(frame)
  })

  it('rejects any single flipped bit via CRC', () => {
    const bytes = encodeFrame(frame)
    for (let bit = 4 * 8; bit < bytes.length * 8; bit += 7) {
      const copy = bytes.slice()
      copy[bit >> 3]! ^= 1 << (bit & 7)
      const result = decodeFrame(copy)
      expect(result.ok).toBe(false)
    }
  })

  it('rejects foreign QR payloads', () => {
    expect(decodeFrame(encoder.encode('https://example.com/some/qr/code'))).toEqual({ ok: false, reason: 'magic' })
    expect(decodeFrame(new Uint8Array(3))).toEqual({ ok: false, reason: 'short' })
    const truncated = encodeFrame(frame).subarray(0, 20)
    expect(decodeFrame(truncated)).toEqual({ ok: false, reason: 'length' })
  })
})

describe('envelope', () => {
  const env: Envelope = {
    size: 123_456,
    encodedSize: 7_890,
    blockSize: 195,
    compression: Compression.Deflate,
    sha256: Uint8Array.from({ length: 32 }, (_, i) => i),
    mime: 'application/json',
    filename: '반출-승인.json',
  }

  it('round-trips, including UTF-8 filenames', () => {
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env)
  })

  it('rejects truncated or trailing bytes', () => {
    const bytes = encodeEnvelope(env)
    expect(decodeEnvelope(bytes.subarray(0, bytes.length - 1))).toBeNull()
    expect(decodeEnvelope(Uint8Array.from([...bytes, 0]))).toBeNull()
  })

  it('truncates filenames to a byte budget, keeping the extension', () => {
    expect(truncateFilename('short.json', 40)).toBe('short.json')
    const cut = truncateFilename('a-very-long-export-name-from-the-server.json', 20)
    expect(cut.endsWith('.json')).toBe(true)
    expect(encoder.encode(cut).length).toBeLessThanOrEqual(20)
    const korean = truncateFilename('아주긴한국어파일이름입니다.txt', 16)
    expect(encoder.encode(korean).length).toBeLessThanOrEqual(16)
    expect(korean.endsWith('.txt')).toBe(true)
  })

  it('sanitizes received filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe')
    expect(sanitizeFilename('..hidden')).toBe('hidden')
    expect(sanitizeFilename('a<b>:"c"|?*.txt')).toBe('a_b___c____.txt')
    expect(sanitizeFilename('bad\u0000name\u001b.json')).toBe('badname.json')
    expect(sanitizeFilename('')).toBe('opticast.bin')
  })
})
