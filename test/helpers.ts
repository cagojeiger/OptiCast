/** Deterministic bytes (xorshift32) so failures reproduce. */
export function randomBytes(n: number, seed = 7): Uint8Array {
  let s = seed >>> 0 || 1
  return Uint8Array.from({ length: n }, () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return Math.floor(((s >>> 0) / 4294967296) * 256)
  })
}
