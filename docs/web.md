# Receiver (web)

A phone browser (iPhone Safari first) films the terminal and rebuilds the file. Everything runs on the device; nothing is uploaded. The same address shows a setup page on a desktop. UI rules and the state table: [DESIGN.md](../DESIGN.md).

## 1. Address

| | |
|---|---|
| Desktop with a mouse (`(hover: hover) and (pointer: fine)`) | Setup page: download, send command, QR |
| Phone, or the home-screen app | Receiver |
| `?receiver=1` | Receiver on a desktop too |
| `?max=256` | Largest file in MiB (default 64, 1–512) |
| `?cap=3840` and `?scan=3840` | Ask the camera for 4K and decode it at full width: twice the pixels per module, about four times the work |
| `?debug=1` | Draw finders and tile centres; show the decoder's JSON stats |

## 2. States

`○ Idle` / `○ Looking` / `○ Paused` → `● Receiving` → `✓ Received · SHA-256 verified`, or `✕ Error`. The strip changes colour in one place; the buttons never move and are only enabled or disabled. A file counts as received only after RaptorQ decode, size check and SHA-256 match; until then progress stops at 99 %. Errors say what to do in one sentence (camera denied, camera taken by another app, file too large, decoder error → **Reload** in place of Start).

One line of text sits over the camera; the most urgent wins: a camera, share or restore failure, then opening the camera, file too large, received, paused, looking, receiving. Download only starts a download, so Reset still asks before discarding the file; Share counts as saved once it succeeds.

## 3. Hints

The frame border is green when ≥ 70 % of tiles pass, orange when some do, red when none. One advice line, from the last 2 s:

| Condition | Advice |
|---|---|
| Grid in under half the frames, stopped at finders | Frame the whole screen, all four corner marks |
| 〃, at timing lines or format | The grid is blurred: hold still, at a distance that focuses (with modules < 4.5 px: the sideways or closer advice below) |
| 〃, at geometry | The grid looks bent: face the screen, a little further back |
| Tiles read ≥ 90 % | You can raise the sender fps (+) |
| Tiles read < 70 %, modules < 4.5 px, portrait | Hold the phone sideways for a larger grid |
| Tiles read < 70 %, modules < 4.5 px | The grid cells are small: move closer or enlarge the terminal font |
| Tiles read < 70 % | Lower the sender fps (-) |

## 4. Storage

- The received file stays in this browser (IndexedDB) until it is shared, the next file arrives, or Reset — at most 24 h. A reload offers it again. It is never opened; it is saved only by Share or Download.
- Collected tiles are saved every 5 s and when the tab is hidden, so a reload resumes the same transfer. Entries older than 7 days or beyond 128 MiB in total are dropped.
- Browser storage belongs to the page's origin. On `*.github.io` that origin is shared with the account's other Pages sites.

## 5. Offline

Add to Home Screen opens it like an app. A service worker caches each deploy under its commit and works offline; a new deploy replaces the cache on the next online visit. The home-screen app has its own storage, separate from Safari.

## 6. Diagnostics

The ⓘ sheet shows capture and processing fps, decode time, tiles read, module size, the stage most frames stop at, and a camera picker (choose a single lens such as "Back Camera" on an iPhone Pro to stop the automatic lens switch). **Copy diagnostics** copies device, camera and recognition numbers as JSON — never the file's name, size or content, the transfer ID, or device IDs.

## 7. Vision (`crates/diodecam-vision`)

1. **Binarize** with a local mean (integral image); both polarities.
2. **Finders**: 1:1:3:1:1 runs, cross-checked; three passes with different windows, their candidates merged so near and far finders of a tilted view are found together.
3. **Timing lines** give W, H and the module pitch: by counting edges when sharp, by the phase of the 1-0-1-0 pattern when blurred. **Format information** (CRC-8, three copies) confirms the size.
4. **Geometry**: a homography from the four finders, checked against all four timing lines; lens distortion corrected from the residuals.
5. **Sampling**: each module's centre against its neighbourhood mean.
6. **Tracking**: the next frame looks near the last finders. A lost grid of large modules is searched at half scale first; an empty view is searched every other frame.

Floor (`node tools/floor.ts`, simulated 1080p camera): every tile reads from 2.9 px per module when sharp, 3.4 px with 2 px of blur, 4.9 px with 3 px. Real phones refocus, so the hints use 4.5 px. Known limits: strong lens distortion (k₁ > 0.018) and the iPhone's automatic lens switch.
