// Static file server for the receiver: web/ as it is, no build step. The query
// string (`?v=…`) is ignored; nothing is cached, so a reload always gets the
// files on disk. localhost is a secure context, so the camera works.
//
// usage: node tools/serve.ts [dir = web] [port = 5173]

import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
}

/** Serves `dir` on 127.0.0.1:`port` (0: any free port); resolves once listening. */
export function serve(dir: string, port: number): Promise<Server> {
  const root = resolve(dir)
  const server = createServer(async (req, res) => {
    // URL parsing resolves `..` segments, so the path stays inside `root`.
    let path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path.endsWith('/')) path += 'index.html'
    try {
      const body = await readFile(join(root, path))
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir = 'web', port = '5173'] = process.argv.slice(2)
  await serve(dir, Number(port))
  console.log(`serving ${resolve(dir)} at http://127.0.0.1:${port}/`)
}
