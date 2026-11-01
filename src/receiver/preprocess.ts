// Frame preprocessing before QR detection.
//
// jsQR's binarizer (ZXing's HybridBinarizer) treats an 8×8 block as flat only
// when its brightness range is under 24. Camera noise past σ≈5 at scan
// resolution breaks that, so flat white areas get a per-block threshold and turn
// into speckle. A 3×3 box blur after capture restores it (see tools/probe).

/** In place: replace RGBA with a 3×3 box-blurred luma (R = G = B). */
export function denoise(rgba: Uint8ClampedArray, width: number, height: number): void {
  const n = width * height
  const luma = new Uint16Array(n)
  for (let i = 0; i < n; i++) luma[i] = (rgba[i * 4]! * 77 + rgba[i * 4 + 1]! * 150 + rgba[i * 4 + 2]! * 29) >> 8
  const rows = new Uint16Array(n)
  for (let y = 0; y < height; y++) {
    const at = y * width
    for (let x = 0; x < width; x++) {
      rows[at + x] = luma[at + Math.max(0, x - 1)]! + luma[at + x]! + luma[at + Math.min(width - 1, x + 1)]!
    }
  }
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const at = y * width
    const down = Math.min(height - 1, y + 1) * width
    for (let x = 0; x < width; x++) {
      const v = (rows[up + x]! + rows[at + x]! + rows[down + x]!) / 9
      const i = (at + x) * 4
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    }
  }
}
