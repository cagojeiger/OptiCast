// Runs cargo for the TS tooling (wasm build, e2e). On Apple-silicon Macs the
// default rustup toolchain may be x86_64 ("Bad CPU type") and Xcode may need a
// license acceptance; unless the caller set them, use the native toolchain and
// the Command Line Tools linker.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export function cargoEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    env.RUSTUP_TOOLCHAIN ??= 'stable-aarch64-apple-darwin'
    if (!env.DEVELOPER_DIR && existsSync('/Library/Developer/CommandLineTools')) env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools'
  }
  return env
}

export function cargo(args: string[]): void {
  const result = spawnSync('cargo', args, { stdio: 'inherit', env: cargoEnv() })
  if (result.status !== 0) throw new Error(`cargo ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`)
}
