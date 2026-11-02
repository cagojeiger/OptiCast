// The real sender's frames for the simulators: the hidden `diodecam frames` command
// run on a file, its JSON lines parsed back (crates/diodecam-cli/src/frames.rs).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cargo } from '../cargo.ts'

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

export interface SenderOptions {
  bytes: Uint8Array
  /** The file name the frames carry in META. */
  name: string
  cols: number
  rows: number
  count: number
  /** Frames generated and dropped first (a receiver joining mid-stream). */
  skip?: number
  profile?: 'auto' | 'ssh' | 'vt100'
}

/** The first JSON line `diodecam frames` writes. */
export interface SenderHeader {
  format: string
  version: number
  cols: number
  rows: number
  profile: string
  width: number
  height: number
  tiles: number
  id: string
  name: string
  size: number
  payload: number
  compression: string
  source_symbols: number
  skip: number
  count: number
}

/**
 * `count` consecutive frames' ANSI text, after `skip`. Without `bin` it goes through
 * `cargo run`, so the sender is never stale; with `bin` it runs that binary.
 */
export function senderFrames(opts: SenderOptions, bin?: string): { header: SenderHeader; frames: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'diodecam-sender-'))
  try {
    const input = join(dir, opts.name)
    const out = join(dir, 'frames.jsonl')
    writeFileSync(input, opts.bytes)
    const args = ['frames', input, '--cols', `${opts.cols}`, '--rows', `${opts.rows}`, '--count', `${opts.count}`, '--out', out]
    if (opts.skip !== undefined) args.push('--skip', `${opts.skip}`)
    if (opts.profile) args.push('--profile', opts.profile)
    if (bin) {
      const run = spawnSync(bin, args)
      if (run.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${run.stderr?.toString() || run.error?.message}`)
    } else cargo(['run', '-q', '-p', 'diodecam-cli', '--', ...args])
    const [header, ...lines] = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    if (header?.format !== 'diodecam-frames') throw new Error(`${out}: not a diodecam frames file`)
    return { header, frames: lines.map((l: { ansi: string }) => l.ansi) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
