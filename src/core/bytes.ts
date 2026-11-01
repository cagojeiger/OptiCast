// Byte helpers built only on Web standard APIs (Web Crypto, Compression Streams),
// which Node and browsers both provide, so sender and receiver share one implementation.

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Inflate, refusing to produce more than `maxBytes` (guards against decompression bombs). */
export async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`decompressed data exceeds declared size (${maxBytes} bytes)`)
    }
    chunks.push(value)
  }
  return concat(chunks, total)
}

export function concat(chunks: Uint8Array[], total = chunks.reduce((n, c) => n + c.length, 0)): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function transferIdHex(id: number): string {
  return (id >>> 0).toString(16).padStart(8, '0')
}
