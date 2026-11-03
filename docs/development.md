# Development

## Layout

Each crate is one responsibility. The arrows are the deploy boundaries: what the sender binary contains, and what the receiver page contains.

```
crates/diodecam-core     the screen format: layout, tiles, RS, RaptorQ, META, ANSI; sender schedule; receiver assembly. No I/O.
crates/diodecam-cli      the sender binary: arguments, file, terminal, keys, status lines          → core + cli = `diodecam`
crates/diodecam-vision   camera image → module grid                                              → core + vision + wasm = web/diodecam.wasm
crates/diodecam-wasm     C ABI for the browser: vision + core assembly, stats, resume
crates/diodecam-sim      test-only terminal and camera (Rust)
web/                     the receiver and setup page: plain ES modules, no build
tools/                   wasm build, local server, e2e, generators; tools/sim is the TS simulator
```

Two simulators: `crates/diodecam-sim` films a module grid with 3D pose, lens distortion and both themes for the vision tests; `tools/sim` replays the real sender's bytes through the shipped wasm and JS (receiver test, e2e, floor). New vision cases go to the Rust one.

Everything in the repository is English.

## Build and test

```sh
cargo build --release                   # target/release/diodecam
cargo test --workspace --release        # Rust tests (core golden bytes, vision, CLI)
pnpm install && pnpm typecheck          # JSDoc types over web/ and tools/
pnpm wasm && pnpm test                  # build web/diodecam.wasm, run the JS tests
pnpm serve                              # receiver at http://localhost:5173
pnpm e2e                                # real sender → simulated camera → Chrome → byte compare
cargo test -p diodecam-cli --test tmux_probe -- --ignored   # a real tmux terminal: restore, resize, q
node tools/floor.ts [cols] [rows]       # decoder floor: tiles read per module size and blur
```

On an Apple-silicon Mac whose default rustup toolchain is x86_64, prefix cargo with `RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin DEVELOPER_DIR=/Library/Developer/CommandLineTools` (the pnpm scripts do this).

Generated files: `node tools/icons.ts` (icons), `node tools/qr.ts` (setup-page QR), `node tools/terminal-example.ts` (the terminal picture), `node tools/third-party-licenses.ts` (THIRD_PARTY_LICENSES.md, after Cargo.lock changes), `node tools/e2e.ts --shots docs/images --size 600000 --url <deployed>` (README images).

## Speed on a phone

The terminal's KB/s is the best case (every tile read); the phone's ✓ strip shows what arrived: the time from the first tile read, and size over that time.

```sh
head -c 1000000 /dev/urandom > bench.bin   # random, so compression cannot help
diodecam bench.bin                         # note the terminal size, fps and KB/s
```

Start the camera, frame the grid, and keep the camera on until ✓ (a pause or a reload shows the arrival time instead). Phone KB/s ÷ terminal KB/s is the share of the screen's rate that arrived; repeat three times and take the middle one.

## Release

- **CI** (`.github/workflows/ci.yml`, every PR and `main`): types, fmt, clippy, tests, wasm, JS tests, and the site assembled with the commit and version filled in, plus a check that the setup-page terminal picture is current and a separate `e2e` job (real Chrome against the real sender; not yet required for the deploy). `main` deploys the site to GitHub Pages.
- **Release** (`release.yml`, tag `vX.Y.Z`): builds the sender for Linux (musl) and macOS beside the tests and, once both pass, attaches `diodecam-<target>.tar.gz` + `.sha256` (binary, LICENSE, THIRD_PARTY_LICENSES.md, README). The names carry no version, so `releases/latest/download/…` stays fixed.
- The version lives only in `Cargo.toml`. PRs are squash-merged as `type(scope): summary (#N)`.
