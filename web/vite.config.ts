import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// Receiver v2. `--mode https` serves a self-signed certificate so a phone on
// the LAN gets a secure context (required for getUserMedia); localhost is
// secure without it. The WebAssembly module comes from `pnpm wasm:build`.
export default defineConfig(({ mode }) => ({
  root: 'web',
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  build: {
    outDir: '../dist/receiver-v2',
    emptyOutDir: true,
    // iPhone Safari 15+ (module workers); nothing newer than iOS 16.4 is needed.
    target: ['es2020', 'safari15'],
  },
  worker: {
    format: 'es',
  },
}))
