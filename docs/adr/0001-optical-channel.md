# ADR 0001: Screen channel — one-way broadcast, `▀` half-block grid, tiles

- Status: Accepted
- Date: 2026-11-01

## Context

From an isolated server, the only way out is the character cells of an SSH terminal, and the receiver is a phone browser. Light travels in one direction only,
so there is no ACK and no retransmission request. The receiver may start capturing at any time, and a photo taken while the screen is changing mixes two frames.

## Decision

- The sender **broadcasts endlessly**. Only the phone knows when the transfer is complete, so the person sees "received" and presses `q`.
- The screen uses only `' '`, `'▀'`, and reverse video (SGR 7), and **no color codes**. One cell = 2 modules, upper and lower, and the lower module is the cell background.
  On non-UTF-8 tmux/screen it falls back to `vt100` (cell = 1 module), which uses only space + reverse video.
- Instead of a QR code, **one grid that uses the whole terminal**: 3 large finders + 1 small finder, 4 timing lines,
  and format information (W, H, profile) repeated 3 times + CRC-8. The receiver reads the size from every frame, so the window can be resized during transfer.
- The unit of transfer is a **1024-module (128 B) tile**, and each tile is verified separately. A frame is written in one go inside `ESC[?2026h … l`.
- The default is **24 fps**. 30, the same as a 30 fps camera, can be captured at the same phase every time (while redrawing).

## Rationale

- Terminal graphics (sixel, kitty): support differs between SSH clients. Color, braille, and quadrant blocks: these depend on the theme and the font.
  Foreground/background color is the maximum-contrast pair of that terminal in any theme. Measured: 0 module errors with dark and light themes and line spacing of 0/3 px.
- QR (v1): one v10 symbol is 3,249 modules, while a 200×55 grid is 21,094 modules. If it tears, the whole symbol is lost.
- Verifying whole frames: with a 40 ms draw time at 15 fps, only 26% of frames were clean. With 8-row tiles it was 100%.

## Consequences

- 1 bit per module. At 200×55 that is 1.73 KB per frame, or 41.5 KB/s at 24 fps.
- Even from a torn photo, only the tiles the mixed rows passed through are discarded (e2e: 99% recognition with 40% of captures torn).
- QR libraries cannot be used, so the receiver vision is built from scratch ([0003](0003-implementation.md)).
- The user must press `q` after saving. If the transmission stops, the file cannot be received again.
