# Receiver (web)

A phone browser (iPhone Safari first) rebuilds the file on the device; nothing is uploaded or opened.

## 1. Address

Desktop browsers with a mouse show setup; phones and the home-screen app show the receiver.

| Query | Effect |
|---|---|
| `?receiver=1` | Force the receiver on desktop |
| `?max=256` | File limit in MiB (default 64, range 1–512); larger files need more phone memory |
| `?cap=3840&scan=3840` | Request 4K capture and decoding instead of the default 1920-wide image; about four times the work if the camera supports it |
| `?debug=1` | Draw finders and tile centres; show decoder JSON |

## 2. States

Files become available after decoding, size checking and SHA-256 verification. Download only starts a browser download, so Reset still asks before discarding the file; a successful Share counts as saved.
A fatal decoder error requires Reload to recover saved progress. Exact states, timing and button behavior live in [web/view.js](../web/view.js).

## 3. Hints

Follow the on-screen advice to adjust framing, distance or sender fps. Recognition conditions and wording live in [web/metrics.js](../web/metrics.js).

## 4. Storage

- IndexedDB keeps one verified file until Share, replacement or Reset. A reload offers it again; files older than 24 h are deleted on lookup.
- Every 5 s and when the tab is hidden, new tiles are appended to saved progress. After reload, point at the same transfer to resume. Reset or failed verification deletes that transfer's progress.
- Progress expires after 7 days. Size eviction removes older entries beyond a 128 MiB total budget, protecting the current or latest transfer even if it exceeds that budget.
- Storage is best effort: browser quota, eviction or write failure can prevent recovery. The chunk-storage upgrade drops progress saved by older versions once, while keeping the verified file.
- Storage belongs to the page's origin; `*.github.io` shares it with the account's other Pages sites. Implementation: [web/store.js](../web/store.js).

## 5. Offline

After an online visit has cached the receiver, Add to Home Screen can open it offline. Each deploy has its own service-worker cache, replaced on an online update. The home-screen app has storage separate from Safari. Cache behavior: [web/sw.js](../web/sw.js).

## 6. Diagnostics

The ⓘ sheet shows camera/processing rates, decode time, tile recognition, module size and the failing stage. On an iPhone Pro, choose a single lens such as “Back Camera” to avoid automatic lens switching.
Copy diagnostics includes device, camera and recognition numbers, excluding file name, size, content, transfer ID and device IDs. Fields are selected in [web/view.js](../web/view.js); phone speed measurement is in [development.md](development.md#speed-on-a-phone).

## 7. Vision (`crates/diodecam-vision`)

The [vision crate](../crates/diodecam-vision/src/lib.rs) detects and tracks the grid and samples its modules; algorithm details belong with that code.
Small modules, blur, strong lens distortion and iPhone automatic lens switching can prevent recognition. [tools/floor.ts](../tools/floor.ts) measures module-size limits with a simulated camera; its results do not establish real-phone performance.
