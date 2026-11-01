import { describe, expect, it } from 'vitest'
import { Assembler, Compression, decodeFrame, encodeFrame, FrameType, prepareTransfer } from '../src/core/index.ts'
import { randomBytes, rng, shuffle } from './helpers.ts'

const json = new TextEncoder().encode(
  JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, approved: i % 2 === 0, note: `row ${i}` })) }),
)

async function receive(frames: Uint8Array[]) {
  const assembler = new Assembler()
  for (const f of frames) {
    assembler.accept(f)
    if (assembler.complete) break
  }
  return assembler
}

describe('prepareTransfer', () => {
  it('deflates compressible data and leaves random data alone', async () => {
    const compressible = await prepareTransfer(json, { filename: 'a.json', blockSize: 150 })
    expect(compressible.envelope.compression).toBe(Compression.Deflate)
    expect(compressible.envelope.encodedSize).toBeLessThan(json.length)

    const random = await prepareTransfer(randomBytes(3000), { filename: 'r.bin', blockSize: 150 })
    expect(random.envelope.compression).toBe(Compression.None)
    expect(random.blockCount).toBe(20)
  })

  it('puts a META frame before every metaEvery-th data frame', async () => {
    const t = await prepareTransfer(randomBytes(3000), { filename: 'r.bin', blockSize: 150, metaEvery: 8 })
    const types = t.cycle.map((f) => {
      const result = decodeFrame(f)
      if (!result.ok) throw new Error(result.reason)
      return result.frame.type
    })
    expect(types.filter((x) => x === FrameType.Meta)).toHaveLength(3) // before blocks 0, 8, 16
    expect(types[0]).toBe(FrameType.Meta)
    expect(t.cycle).toHaveLength(23)
  })

  it('is deterministic, and the transfer id depends on framing parameters', async () => {
    const a = await prepareTransfer(json, { filename: 'a.json', blockSize: 150 })
    const b = await prepareTransfer(json, { filename: 'a.json', blockSize: 150 })
    const c = await prepareTransfer(json, { filename: 'a.json', blockSize: 151 })
    expect(b.cycle).toEqual(a.cycle)
    expect(c.transferId).not.toBe(a.transferId)
  })

  it('refuses frames too small for the envelope', async () => {
    await expect(prepareTransfer(json, { filename: 'a.json', blockSize: 40 })).rejects.toThrow(/envelope/)
  })
})

describe('Assembler (cyclic broadcast)', () => {
  it('restores the exact bytes from one clean cycle', async () => {
    const t = await prepareTransfer(json, { filename: 'export.json', mime: 'application/json', blockSize: 120 })
    const assembler = await receive(t.cycle)
    const { envelope, data } = await assembler.finalize()
    expect(data).toEqual(json)
    expect(envelope.filename).toBe('export.json')
  })

  it('joins mid-cycle, tolerates shuffle, duplicates and 40% loss per cycle', async () => {
    const original = randomBytes(5000, 3)
    const t = await prepareTransfer(original, { filename: 'r.bin', blockSize: 100 })
    const r = rng(5)
    const stream: Uint8Array[] = []
    // Start in the middle of a cycle; each pass drops 40% and shows some frames twice.
    const start = Math.floor(t.cycle.length / 2)
    for (let pass = 0; pass < 12; pass++) {
      const order = pass === 0 ? t.cycle.slice(start) : t.cycle
      for (const f of shuffle(order, pass + 1)) {
        if (r() < 0.4) continue
        stream.push(f)
        if (r() < 0.3) stream.push(f)
      }
    }
    const assembler = await receive(stream)
    expect(assembler.complete).toBe(true)
    expect(assembler.stats.duplicates).toBeGreaterThan(0)
    expect((await assembler.finalize()).data).toEqual(original)
  })

  it('needs no META first: data blocks seen before META still count', async () => {
    const t = await prepareTransfer(randomBytes(1000), { filename: 'r.bin', blockSize: 100, metaEvery: 1000 })
    const [meta, ...data] = t.cycle
    const assembler = new Assembler()
    data.forEach((f) => assembler.accept(f))
    expect(assembler.received).toBe(t.blockCount)
    expect(assembler.complete).toBe(false)
    expect(assembler.accept(meta!)).toEqual({ kind: 'meta' })
    expect(assembler.complete).toBe(true)
  })

  it('says which block a repeat was, so the receiver can time the cycle', async () => {
    const t = await prepareTransfer(randomBytes(500), { filename: 'r.bin', blockSize: 100 })
    const assembler = new Assembler()
    expect(assembler.accept(t.cycle[2]!)).toEqual({ kind: 'block', index: 1 })
    expect(assembler.accept(t.cycle[2]!)).toEqual({ kind: 'duplicate', index: 1 })
    assembler.accept(t.cycle[0]!)
    expect(assembler.accept(t.cycle[0]!)).toEqual({ kind: 'duplicate' }) // META repeats carry no index
  })

  it('locks onto one transfer and counts frames from another as foreign', async () => {
    const a = await prepareTransfer(randomBytes(800, 1), { filename: 'a.bin', blockSize: 100 })
    const b = await prepareTransfer(randomBytes(800, 2), { filename: 'b.bin', blockSize: 100 })
    const assembler = new Assembler()
    assembler.accept(a.cycle[1]!)
    expect(assembler.accept(b.cycle[1]!).kind).toBe('foreign')
    expect(assembler.stats.foreign).toBe(1)
  })

  it('is not captured by a bogus or stale first frame', async () => {
    const real = await prepareTransfer(randomBytes(800, 4), { filename: 'real.bin', blockSize: 100 })
    const stale = await prepareTransfer(randomBytes(800, 5), { filename: 'old.bin', blockSize: 100 })
    const assembler = new Assembler()
    // CRC-valid but count = 0: rejected without locking anything.
    const bogus = encodeFrame({ type: FrameType.Data, transferId: 1, index: 0, count: 0, payload: new Uint8Array(1) })
    expect(assembler.accept(bogus)).toEqual({ kind: 'invalid', reason: 'index' })
    expect(assembler.transferId).toBeNull()
    // A leftover DATA frame from an earlier broadcast takes only a provisional lock…
    assembler.accept(stale.cycle[1]!)
    expect(assembler.transferId).toBe(stale.transferId)
    // …which the live broadcast's verified META replaces.
    real.cycle.forEach((f) => assembler.accept(f))
    expect(assembler.transferId).toBe(real.transferId)
    expect(assembler.complete).toBe(true)
    // Once confirmed, the old broadcast is reported, never adopted.
    expect(assembler.accept(stale.cycle[0]!).kind).toBe('foreign')
  })

  it('drops wrong-length blocks so the correct copy can still land', async () => {
    const original = randomBytes(600, 6)
    const t = await prepareTransfer(original, { filename: 'r.bin', blockSize: 100 })
    const [meta, d0, ...rest] = t.cycle
    const decoded = decodeFrame(d0!)
    if (!decoded.ok) throw new Error(decoded.reason)
    const short = encodeFrame({ ...decoded.frame, payload: decoded.frame.payload.subarray(0, 3) })
    const assembler = new Assembler()
    assembler.accept(short) // before META it cannot be checked yet
    expect(assembler.received).toBe(1)
    assembler.accept(meta!) // META arrives: the bad block is evicted
    expect(assembler.received).toBe(0)
    expect(assembler.accept(short)).toEqual({ kind: 'invalid', reason: 'length' })
    ;[d0!, ...rest].forEach((f) => assembler.accept(f))
    expect((await assembler.finalize()).data).toEqual(original)
  })

  it('never reports success for tampered data that passes frame CRCs', async () => {
    const t = await prepareTransfer(randomBytes(600), { filename: 'r.bin', blockSize: 100 })
    const forged = t.cycle.map((bytes) => {
      const result = decodeFrame(bytes)
      if (!result.ok || result.frame.type !== FrameType.Data || result.frame.index !== 2) return bytes
      const payload = result.frame.payload.slice()
      payload[0]! ^= 0xff
      return encodeFrame({ ...result.frame, payload }) // valid CRC, wrong content
    })
    const assembler = await receive(forged)
    expect(assembler.complete).toBe(true)
    await expect(assembler.finalize()).rejects.toThrow(/SHA-256 mismatch/)
  })

  it('rejects a deflate stream that inflates past the declared size', async () => {
    const t = await prepareTransfer(json, { filename: 'a.json', blockSize: 2000 })
    const assembler = await receive(t.cycle)
    assembler.envelope!.size = 100 // as if the envelope under-declared the size
    await expect(assembler.finalize()).rejects.toThrow(/exceeds declared size/)
  })

  it('handles an empty file', async () => {
    const t = await prepareTransfer(new Uint8Array(), { filename: 'empty.txt', blockSize: 100 })
    expect(t.blockCount).toBe(1)
    const assembler = await receive(t.cycle)
    expect((await assembler.finalize()).data).toEqual(new Uint8Array())
  })
})
