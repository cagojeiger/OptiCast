import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// `--mode https` serves a self-signed certificate so a phone on the LAN gets a
// secure context (required for getUserMedia). localhost is secure without it.
export default defineConfig(({ mode }) => ({
  root: 'src/receiver',
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  build: {
    outDir: '../../dist/receiver',
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
  },
}))
