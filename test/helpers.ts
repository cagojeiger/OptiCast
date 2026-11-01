/** Deterministic PRNG (xorshift32) so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

export function randomBytes(n: number, seed = 7): Uint8Array {
  const r = rng(seed)
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
}

export function shuffle<T>(items: T[], seed = 11): T[] {
  const r = rng(seed)
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
