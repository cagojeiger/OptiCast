# ADR 0003: Implementation — shared Rust core, minimal-dependency CLI, no-build web receiver

- Status: Accepted
- Date: 2026-11-01

## Context

The sender runs on isolated servers where installing a runtime is hard (distributions, glibc versions, and architectures all differ), and the receiver runs in
iPhone Safari with no app install. The format that is drawn and the format that is read must not diverge. Technology is kept to a minimum.

## Decision

- **Shared Rust core** `diodecam-core` (no I/O): layout, tiles, RS, RaptorQ, META, ANSI, receive assembly. The sender CLI and the receiver WASM use the same code.
- The **CLI** depends only on `crossterm` (raw mode and terminal size only, event feature off) and `signal-hook`. Arguments are parsed by hand,
  key input comes from a stdin thread, and window resizes come from SIGWINCH. If stdin reaches EOF the terminal is gone, so the program exits.
- The **receiver** is plain JS ES modules with no build step + a Web Worker + WASM (C ABI, no wasm-bindgen).
  Vision (local-mean binarization, run-length finder search, 4-point homography, tracking) is built in-house with no external dependencies. Types are checked only with JSDoc + `tsc`.
- **Safety**: the save button is disabled until the SHA-256 is verified. The META size is compared with the limit (default 64 MiB, up to 512 with `?max=`) before any memory is allocated.
  Received symbols and verified files are stored in IndexedDB so a reload can resume the transfer or save the file again. Nothing is uploaded.
- **Home-screen app**: manifest + service worker. The cache name is the commit, so files from different deployments never mix, and it opens offline too.
- **Deployment**: push to `main` → GitHub Pages after tests pass (WASM build + file copy); `v*` tag → GitHub Releases (static musl + macOS, file names without versions).

## Rationale

- Node/Python need a runtime on the server, and Go makes it hard to share the core with the browser. Rust gives both a static binary and wasm32.
- `clap` adds a dozen or so crates to a CLI with 4 options. crossterm events (mio) loop forever on EOF when the terminal disappears
  (0.28.1, not fixed upstream; an orphaned process actually stayed at 100% CPU for 4 hours). Removing both and `libc` cut dependency crates from 49 to 29 and the binary from 1.08 MB to 752 KB.
- Vite, bundlers, and a TS build are unnecessary when the browser runs ES modules directly. Static files are deployed as they are.
- Instead of OpenCV.js (several MB), zxing (QR only), or AprilTag (C), custom vision: the grid structure is known, so there is little to do (full 1080p search 9.2 ms, tracking 1.7 ms).

## Consequences

- A spec change is made in one place in the core and applies to both sending and receiving.
- Known limits: recognition fails with lens distortion k1 > 0.018, automatic lens switching on iPhone (ultra-wide when shooting close), and modules that are too small (under 4.5 px).
  The receiver shows the failing stage and the module size and lets the user pick a single lens (`docs/web.md` section 6), so the cause can be identified on real devices.
  If the main causes turn out to be things the web cannot control (lens lock, focus and exposure lock), an iOS app using the same C ABI will be considered.
