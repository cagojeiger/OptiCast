// Resume support (receiver-v2 §4): the collected tiles of an unfinished transfer
// are kept in IndexedDB under its transfer ID, in this browser only.
//
// Two object stores: `meta` (small records, read for eviction) and `tiles` (the
// export bytes). Entries older than 7 days, or beyond 128 MiB in total (oldest
// first), are evicted; a corrupt entry is deleted when it is loaded.

const DB = 'opticast-v2'
const VERSION = 2
const META = 'meta'
const TILES = 'tiles'
const MAX_AGE_MS = 7 * 24 * 3600 * 1000
const MAX_TOTAL_BYTES = 128 * 2 ** 20
const TILE_BYTES = 108

export interface SavedMeta {
  id: string
  name: string
  size: number
  savedAt: number
  /** Tiles in the export. */
  tiles: number
  bytes: number
}

export interface Saved extends SavedMeta {
  data: ArrayBuffer
}

/** Tile count of a well-formed export ("OCS1", count, 108 bytes per tile), else −1. */
export function exportTiles(data: unknown): number {
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
 */
export function evictable(entries: SavedMeta[], now: number, keep: string | null): string[] {
  const out: string[] = []
  let total = entries.find((e) => e.id === keep)?.bytes ?? 0
  for (const e of [...entries].sort((a, b) => b.savedAt - a.savedAt)) {
    if (e.id === keep) continue
    if (now - e.savedAt > MAX_AGE_MS || total + e.bytes > MAX_TOTAL_BYTES) out.push(e.id)
    else total += e.bytes
  }
  return out
}

function open(): Promise<IDBDatabase> {
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

async function transaction<T>(mode: IDBTransactionMode, body: (meta: IDBObjectStore, tiles: IDBObjectStore) => () => T): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
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

async function remove(id: string): Promise<void> {
  await transaction('readwrite', (meta, tiles) => {
    meta.delete(id)
    tiles.delete(id)
    return () => undefined
  })
}

/** The saved metadata for `id`, if any. */
async function info(id: string): Promise<SavedMeta | undefined> {
  return transaction('readonly', (meta) => {
    const req = meta.get(id) as IDBRequest<SavedMeta | undefined>
    return () => req.result
  })
}

/** The saved entry for `id`; a malformed one is deleted and reported as absent. */
async function load(id: string): Promise<Saved | undefined> {
  const [m, data] = await transaction('readonly', (meta, tiles) => {
    const a = meta.get(id) as IDBRequest<SavedMeta | undefined>
    const b = tiles.get(id) as IDBRequest<unknown>
    return () => [a.result, b.result] as const
  })
  if (!m && data === undefined) return undefined
  const count = exportTiles(data)
  if (!m || count < 0 || count !== m.tiles) {
    await remove(id)
    return undefined
  }
  return { ...m, data: data as ArrayBuffer }
}

/** Saves an export, then evicts old or excess entries (never this one). */
async function save(entry: Omit<Saved, 'tiles' | 'bytes'>): Promise<void> {
  const tiles = exportTiles(entry.data)
  if (tiles < 0) return
  const record: SavedMeta = { id: entry.id, name: entry.name, size: entry.size, savedAt: entry.savedAt, tiles, bytes: entry.data.byteLength }
  await transaction('readwrite', (meta, store) => {
    meta.put(record)
    store.put(entry.data, entry.id)
    return () => undefined
  })
  await evict(entry.id)
}

async function evict(keep: string | null = null): Promise<void> {
  const all = await transaction('readonly', (meta) => {
    const req = meta.getAll() as IDBRequest<SavedMeta[]>
    return () => req.result
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

export const store = {
  available: typeof indexedDB !== 'undefined',
  info,
  load,
  save,
  remove,
  evict,
}
