// YUV4MPEG2 writer for Chrome's --use-file-for-fake-video-capture.

import { closeSync, openSync, writeSync } from 'node:fs'
import type { GrayImage } from './vterm.ts'

export class Y4mWriter {
  readonly width: number
  readonly height: number
  private readonly fd: number
  private readonly chroma: Uint8Array
  frames = 0

  // No parameter properties: Node's type stripping only accepts erasable syntax.
  constructor(path: string, width: number, height: number, fps: number) {
    if (width % 2 || height % 2) throw new Error('y4m 4:2:0 needs even dimensions')
    this.width = width
    this.height = height
    this.fd = openSync(path, 'w')
    this.chroma = new Uint8Array((width / 2) * (height / 2)).fill(128)
    writeSync(this.fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)
  }

  write(img: GrayImage): void {
    if (img.width !== this.width || img.height !== this.height) throw new Error('frame size mismatch')
    writeSync(this.fd, 'FRAME\n')
    writeSync(this.fd, img.data)
    writeSync(this.fd, this.chroma)
    writeSync(this.fd, this.chroma)
    this.frames++
  }

  close(): void {
    closeSync(this.fd)
  }
}
