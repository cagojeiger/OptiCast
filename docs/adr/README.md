# Architecture Decision Records

These records hold only structural decisions and their reasons. The bit-level specification is [`../protocol.md`](../protocol.md).

| ADR | Decision |
|---|---|
| [0001](0001-optical-channel.md) | One-way broadcast, `▀` half-block grid, independently verified tiles |
| [0002](0002-coding.md) | RS(128,108) + CRC-32C inside a tile, RaptorQ across tiles, repeated META |
| [0003](0003-implementation.md) | Shared Rust core, minimal-dependency CLI, no-build web receiver, static deployment |

| Layer | Choice |
|---|---|
| Screen | `' '`/`'▀'` + reverse video, no color, `ESC[?2026h` synchronized output |
| Grid | 4 finders, 4 timing lines, format information ×3 + CRC-8, 1024-module tiles |
| Coding | `reed-solomon` 0.2.1, `crc` 3 (CRC-32C), `raptorq` 2.0.1, `sha2`, `flate2` |
| Sender | Rust binary, `crossterm` (raw mode and size only), `signal-hook` |
| Receiver | Plain JS ES modules + Worker + Rust→WASM (C ABI), custom vision |
| Deployment | GitHub Pages (receiver), GitHub Releases (static musl binaries) |
