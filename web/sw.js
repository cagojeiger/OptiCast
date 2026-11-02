// @ts-check
// Offline copy of the receiver (docs/web.md §5), so the home-screen app opens
// without a network. Registered only on the deployed site, where `__V__` is the
// commit: each deploy is one cache, filled when it installs and the only one
// left once it activates. Pages are network-first (with a short timeout, so a
// dead network falls back quickly) and served from this deploy's copy offline;
// everything else is cache-first, since a versioned URL never changes.

/** @typedef {Event & { waitUntil(p: Promise<unknown>): void }} ExtendableEvent */
/** @typedef {ExtendableEvent & { request: Request, respondWith(r: Promise<Response>): void }} FetchEvent */

const sw = /** @type {any} */ (self)
const VERSION = '__V__'
const CACHE = `diodecam-${VERSION}`
const PAGE = './'
const FILES = [
  'style.css',
  'main.js',
  'setup.js',
  'qr.svg',
  'icon.svg',
  'example-terminal.svg',
  'privacy.html',
  'terms.html',
  'licenses.html',
  'metrics.js',
  'store.js',
  'worker.js',
  'wasm.js',
  'diodecam.wasm',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
].map((f) => `./${f}?v=${VERSION}`)
const NETWORK_MS = 3000

sw.addEventListener('install', (/** @type {ExtendableEvent} */ event) => {
  event.waitUntil(install().then(() => sw.skipWaiting()))
})

/**
 * Fills this deploy's cache. Pages ignores the query string, so a deploy landing
 * meanwhile would mix files: the page is checked before and after, and any
 * failure drops the cache (the previous deploy's stays in use).
 */
async function install() {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(PAGE, { cache: 'reload' })
    if (!response.ok || !(await ours(response.clone()))) throw new Error('the page is from another deploy')
    await cache.put(PAGE, response)
    await cache.addAll(FILES)
    if (!(await ours(await fetch(PAGE, { cache: 'reload' })))) throw new Error('a deploy landed during the install')
  } catch (err) {
    await caches.delete(CACHE)
    throw err
  }
}

/** @param {Response} response */
async function ours(response) {
  return response.ok && (await response.text()).includes(`?v=${VERSION}`)
}

sw.addEventListener('activate', (/** @type {ExtendableEvent} */ event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('diodecam-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  )
})

sw.addEventListener('fetch', (/** @type {FetchEvent} */ event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(page(request))
    return
  }
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(request))
      .then((hit) => hit ?? fetch(request)),
  )
})

/**
 * The network's page when it answers in time, else this deploy's copy (any
 * query string: `?max=`, `?debug=1` are read by the page itself).
 * @param {Request} request
 */
async function page(request) {
  const network = fetch(request)
  network.catch(() => {}) // may fail after the timeout won
  /** @type {Promise<undefined>} */
  const late = new Promise((done) => setTimeout(() => done(undefined), NETWORK_MS))
  try {
    const fresh = await Promise.race([network, late])
    if (fresh?.ok) return fresh
  } catch {
    // offline
  }
  const copy = await (await caches.open(CACHE)).match(new URL(PAGE, sw.registration.scope))
  return copy ?? network
}
