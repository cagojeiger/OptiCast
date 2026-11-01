// Envelope: transfer metadata carried in META frames.
//
//   offset size field
//   0      4    original size
//   4      4    encoded size (after compression; = concatenated DATA payloads)
//   8      2    block size (payload bytes per DATA frame; the last may be shorter)
//   10     1    compression (0 = none, 1 = deflate-raw)
//   11     32   sha256 of the original bytes
//   43     1    mime length, then mime (utf-8)
//   ..     1    filename length, then filename (utf-8)

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const Compression = { None: 0, Deflate: 1 } as const
export type Compression = (typeof Compression)[keyof typeof Compression]

export const ENVELOPE_FIXED_SIZE = 45
const SHA256_SIZE = 32
const FALLBACK_FILENAME = 'opticast.bin'

export interface Envelope {
  size: number
  encodedSize: number
  blockSize: number
  compression: Compression
  sha256: Uint8Array
  mime: string
  filename: string
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  const mime = encoder.encode(env.mime)
  const name = encoder.encode(env.filename)
  if (mime.length > 0xff || name.length > 0xff) throw new RangeError('mime/filename longer than 255 bytes')
  if (env.sha256.length !== SHA256_SIZE) throw new RangeError('sha256 must be 32 bytes')
  const out = new Uint8Array(ENVELOPE_FIXED_SIZE + mime.length + name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, env.size)
  view.setUint32(4, env.encodedSize)
  view.setUint16(8, env.blockSize)
  out[10] = env.compression
  out.set(env.sha256, 11)
  let at = 11 + SHA256_SIZE
  out[at++] = mime.length
  out.set(mime, at)
  at += mime.length
  out[at++] = name.length
  out.set(name, at)
  return out
}

export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  if (bytes.length < ENVELOPE_FIXED_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const compression = bytes[10]
  if (compression !== Compression.None && compression !== Compression.Deflate) return null
  let at = 11 + SHA256_SIZE
  const mimeLength = bytes[at++]!
  if (at + mimeLength + 1 > bytes.length) return null
  const mimeBytes = bytes.subarray(at, at + mimeLength)
  at += mimeLength
  const nameLength = bytes[at++]!
  if (at + nameLength !== bytes.length) return null
  const nameBytes = bytes.subarray(at, at + nameLength)
  try {
    return {
      size: view.getUint32(0),
      encodedSize: view.getUint32(4),
      blockSize: view.getUint16(8),
      compression,
      sha256: bytes.slice(11, 11 + SHA256_SIZE),
      mime: decoder.decode(mimeBytes),
      filename: decoder.decode(nameBytes),
    }
  } catch {
    return null
  }
}

/** Shorten a filename to at most `maxBytes` of UTF-8, keeping the extension when possible. */
export function truncateFilename(name: string, maxBytes: number): string {
  if (encoder.encode(name).length <= maxBytes) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
  const chars = Array.from(ext ? name.slice(0, dot) : name)
  while (chars.length > 0 && encoder.encode(chars.join('') + ext).length > maxBytes) chars.pop()
  const result = chars.join('') + ext
  return encoder.encode(result).length <= maxBytes ? result : ''
}

/** Make a received filename safe to offer as a download: no paths, no control or reserved characters. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  return cleaned || FALLBACK_FILENAME
}
