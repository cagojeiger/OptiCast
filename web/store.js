// @ts-check
// Resume support (docs/web.md): the collected tiles of an unfinished
// transfer are kept in IndexedDB under its transfer ID, in this browser only.
//
// Two object stores: `meta` (small records, read for eviction) and `tiles` (the
// export bytes). Entries older than 7 days, or beyond 128 MiB in total (oldest
// first), are evicted; a corrupt entry is deleted when it is loaded.

const DB = 'diodecam-v2'
const VERSION = 2
const META = 'meta'
const TILES = 'tiles'
const MAX_AGE_MS = 7 * 24 * 3600 * 1000
const MAX_TOTAL_BYTES = 128 * 2 ** 20
const TILE_BYTES = 108

/**
 * @typedef {object} SavedMeta
 * @property {string} id
 * @property {string} name
 * @property {number} size
 * @property {number} savedAt
 * @property {number} tiles Tiles in the export.
 * @property {number} bytes
 */

/**
 * Tile count of a well-formed export ("OCS1", count, 108 bytes per tile), else −1.
 * @param {unknown} data
 */
export function exportTiles(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 8) return -1
  const view = new DataView(data)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  const count = view.getUint32(4)
  return magic === 'OCS1' && data.byteLength === 8 + count * TILE_BYTES ? count : -1
}

/**
 * Entries to delete: older than 7 days, or past the total size budget. `keep`
 * (the entry just saved) is never deleted and is counted first; the rest are
 * kept newest first.
 * @param {SavedMeta[]} entries
 * @param {number} now
 * @param {string | null} keep
 */
export function evictable(entries, now, keep) {
  /** @type {string[]} */
  const out = []
  let total = entries.find((e) => e.id === keep)?.bytes ?? 0
  for (const e of [...entries].sort((a, b) => b.savedAt - a.savedAt)) {
    if (e.id === keep) continue
    if (now - e.savedAt > MAX_AGE_MS || total + e.bytes > MAX_TOTAL_BYTES) out.push(e.id)
    else total += e.bytes
  }
  return out
}

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name) // v1 layout
      db.createObjectStore(META, { keyPath: 'id' })
      db.createObjectStore(TILES)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Runs `body` in one transaction; resolves with what its returned getter reads once the transaction completes.
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(meta: IDBObjectStore, tiles: IDBObjectStore) => () => T} body
 * @returns {Promise<T>}
 */
async function transaction(mode, body) {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([META, TILES], mode)
      const result = body(tx.objectStore(META), tx.objectStore(TILES))
      tx.oncomplete = () => resolve(result())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** @param {string} id */
export async function remove(id) {
  await transaction('readwrite', (meta, tiles) => {
    meta.delete(id)
    tiles.delete(id)
    return () => undefined
  })
}

/**
 * The saved metadata for `id`, if any.
 * @param {string} id
 * @returns {Promise<SavedMeta | undefined>}
 */
export function info(id) {
  return transaction('readonly', (meta) => {
    const req = meta.get(id)
    return () => req.result
  })
}

/**
 * The saved entry for `id`; a malformed one is deleted and reported as absent.
 * @param {string} id
 * @returns {Promise<(SavedMeta & { data: ArrayBuffer }) | undefined>}
 */
export async function load(id) {
  const [m, data] = await transaction('readonly', (meta, tiles) => {
    const a = meta.get(id)
    const b = tiles.get(id)
    return () => [/** @type {SavedMeta | undefined} */ (a.result), b.result]
  })
  if (!m && data === undefined) return undefined
  const count = exportTiles(data)
  if (!m || count < 0 || count !== m.tiles) {
    await remove(id)
    return undefined
  }
  return { ...m, data }
}

/**
 * Saves an export, then evicts old or excess entries (never this one).
 * @param {{ id: string, name: string, size: number, savedAt: number, data: ArrayBuffer }} entry
 */
export async function save(entry) {
  const tiles = exportTiles(entry.data)
  if (tiles < 0) return
  /** @type {SavedMeta} */
  const record = { id: entry.id, name: entry.name, size: entry.size, savedAt: entry.savedAt, tiles, bytes: entry.data.byteLength }
  await transaction('readwrite', (meta, store) => {
    meta.put(record)
    store.put(entry.data, entry.id)
    return () => undefined
  })
  await evict(entry.id)
}

/** @param {string | null} [keep] */
export async function evict(keep = null) {
  const all = await transaction('readonly', (meta) => {
    const req = meta.getAll()
    return () => /** @type {SavedMeta[]} */ (req.result)
  })
  const doomed = evictable(all, Date.now(), keep)
  if (!doomed.length) return
  await transaction('readwrite', (meta, tiles) => {
    for (const id of doomed) {
      meta.delete(id)
      tiles.delete(id)
    }
    return () => undefined
  })
}
