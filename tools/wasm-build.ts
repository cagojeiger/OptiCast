// Builds the receiver's WebAssembly module (Rust: opticast-vision + opticast-core)
// and copies it next to the web receiver: web/wasm/opticast.wasm.
//
// usage: node tools/wasm-build.ts

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargo } from './cargo.ts'

cargo(['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'opticast-wasm'])
const from = resolve('target/wasm32-unknown-unknown/release/opticast_wasm.wasm')
const to = resolve('web/wasm/opticast.wasm')
mkdirSync(resolve('web/wasm'), { recursive: true })
copyFileSync(from, to)
console.log(`wasm     ${to} (${(statSync(to).size / 1024).toFixed(0)} KiB)`)
