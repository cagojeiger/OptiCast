// Builds the receiver's WebAssembly module (Rust: diodecam-vision + diodecam-core)
// and copies it next to the web receiver: web/diodecam.wasm.
//
// usage: node tools/wasm-build.ts

import { copyFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargo } from './cargo.ts'

cargo(['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'diodecam-wasm'])
const to = resolve('web/diodecam.wasm')
copyFileSync(resolve('target/wasm32-unknown-unknown/release/diodecam_wasm.wasm'), to)
console.log(`wasm     ${to} (${(statSync(to).size / 1024).toFixed(0)} KiB)`)
