// Decodes one camera frame per message off the main thread.

import jsQR from 'jsqr'
import { denoise } from './preprocess.ts'

export interface ScanRequest {
  id: number
  width: number
  height: number
  pixels: ArrayBuffer
  denoise: boolean
}

export interface ScanResponse {
  id: number
  bytes: Uint8Array | null
  /** Symbol corners in scan-canvas pixels: tl, tr, br, bl as x,y pairs. */
  corners: number[] | null
  ms: number
  error?: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null
  postMessage(message: ScanResponse, transfer: Transferable[]): void
}

// Always answer, even on failure: the main thread sends the next frame only after a reply.
scope.onmessage = ({ data: { id, width, height, pixels, denoise: smooth } }) => {
  const started = performance.now()
  try {
    const rgba = new Uint8ClampedArray(pixels)
    if (smooth) denoise(rgba, width, height)
    const code = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' })
    const bytes = code ? new Uint8Array(code.binaryData) : null
    const corners = code
      ? [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomRightCorner, code.location.bottomLeftCorner].flatMap(
          (p) => [p.x, p.y],
        )
      : null
    scope.postMessage({ id, bytes, corners, ms: performance.now() - started }, bytes ? [bytes.buffer] : [])
  } catch (err) {
    scope.postMessage({ id, bytes: null, corners: null, ms: performance.now() - started, error: String(err) }, [])
  }
}
