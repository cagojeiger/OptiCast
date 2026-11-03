# DiodeCam protocol: screen format

This is the bit-level specification that the sender (terminal) and the receiver (phone) must both follow. Sender behavior is in [`cli.md`](cli.md),
receiver behavior is in [`web.md`](web.md), and the design reasons are in [`development.md`](development.md#design-reasons).
All integers are big-endian. A "module" is one dot of the screen grid. Value 1 is the terminal foreground color and 0 is the background color.

## 1. Profiles and grid size

For a terminal of C×R cells, the bottom 2 rows are status lines ([`cli.md`](cli.md)). The grid is W×H modules.

| Profile | W | H | Cell ↔ module |
|---|---|---|---|
| `ssh` (default) | min(C − 1, 511) | min(2·(R − 2), 510) | one cell = 2 modules, upper and lower |
| `vt100` | min(C − 1, 511) | min(R − 2, 511) | one cell = 1 module |

`auto` uses `ssh`. The exception is when `$TMUX` or `$STY` is set and the locale (the first value set among `LC_ALL` → `LC_CTYPE` → `LANG`)
does not contain `UTF-8`/`utf8`. In that case it prints a warning and uses `vt100`. The last column is always left empty (to avoid the pending-wrap state).

### 1.1 Drawing a cell

`ssh`. The lower module is always the cell background.

| Upper | Lower | Output |
|---|---|---|
| 0 | 0 | `' '` (reverse off) |
| 1 | 1 | `' '` (reverse on) |
| 1 | 0 | `'▀'` (reverse off) |
| 0 | 1 | `'▀'` (reverse on) |

`vt100`: 0 is `' '` (reverse off), 1 is `' '` (reverse on).

Reverse video on is `ESC[7m` and off is `ESC[m`. It is sent only when the value changes. Each row starts with `ESC[{row};1H` and ends with `ESC[m`.
No color codes are used.

### 1.2 Frame output

```
ESC[?2026h  grid rows  2 status lines  ESC[?2026l       ← one write
```

At start-up, send `ESC[m ESC[?1049h ESC[?25l ESC[?7l ESC[2J`. On exit, restore with `ESC[?2026l ESC[m ESC[?7h ESC[?25h ESC[?1049l`.
`?2026l` is sent first on exit so the terminal does not stay in synchronized-output mode if a frame write fails.
When the layout or the terminal size changes, send `ESC[2J` before that frame (before `ESC[?2026h`, in the same write).
Each row is written assuming it starts with reverse off (the previous row ends with `ESC[m`, and the status lines use no SGR).

## 2. Grid layout (origin at top left, x = column, y = row)

### 2.1 Margin

x = 0, x = W − 1, y = 0, and y = H − 1 are all 0.

### 2.2 Finders

Large finder (7×7): for cell (i, j) ∈ [0,7)², with d = max(|i − 3|, |j − 3|), the module is 1 if d is 3, 1, or 0, and 0 if d is 2.
Small finder (5×5): with d = max(|i − 2|, |j − 2|), the module is 1 if d is 2 or 0, and 0 if d is 1.
Each finder is surrounded by a 1-module border of 0 (the separator).

| Finder | Top left (x0, y0) | Area including separator |
|---|---|---|
| TL large | (2, 2) | x, y ∈ [1, 9] |
| TR large | (W − 9, 2) | x ∈ [W − 10, W − 2], y ∈ [1, 9] |
| BL large | (2, H − 9) | x ∈ [1, 9], y ∈ [H − 10, H − 2] |
| BR small | (W − 7, H − 7) | x ∈ [W − 8, W − 2], y ∈ [H − 8, H − 2] |

### 2.3 Timing lines

1 and 0 alternate. The module at the start coordinate is 1.

| Line | Position | Range |
|---|---|---|
| Top | y = 5 | x ∈ [10, W − 11] |
| Bottom | y = H − 6 | x ∈ [10, W − 9] |
| Left | x = 5 | y ∈ [10, H − 11] |
| Right | x = W − 6 | y ∈ [10, H − 9] |

### 2.4 Format information (FI)

A 32-bit word, from bit 31 (MSB):

| Bits | Content |
|---|---|
| 31..29 | Version = 2 |
| 28..27 | Profile (0 = ssh, 1 = vt100) |
| 26..18 | W |
| 17..9 | H |
| 8 | 0 (reserved) |
| 7..0 | CRC-8 (polynomial 0x07, initial value 0), computed over bits 31..8 as 3 bytes |

The word is repeated three times to make 96 bits, and these are written in two places (bit 0 = MSB of the first word). The receiver takes a bitwise majority vote and then checks the CRC.

- Top: bits 0..47 at y = 2 and bits 48..95 at y = 3, x ∈ [10, 57]
- Bottom: bits 0..47 at y = H − 4 and bits 48..95 at y = H − 3, x ∈ [10, 57]

### 2.5 Data modules and minimum size

Every module not covered by 2.1 to 2.4 is a data module. They are numbered in row-major order (y outer, x inner).
If D is the number of data modules, the number of tiles per frame is N = ⌊D / 1024⌋.
W ≥ 68, H ≥ 20, and N ≥ 2 are required. Otherwise the sender shows `Terminal too small for DiodeCam (…)` and `Minimum size: …` instead of the grid.
H ≥ 20 ensures that the fixed area at the top (y ≤ 9) and the fixed area at the bottom (y ≥ H − 10) do not overlap.
When W is large, N ≥ 2 can hold even with H < 20, so this is a separate condition (for example `ssh` 512×11, `vt100` 512×21).

## 3. Tiles

Tile n (0 ≤ n < N) uses data modules [1024n, 1024n + 1024). It is 128 bytes, and each byte is placed on the modules starting from the MSB.
The remaining data modules (D − 1024N of them) are filled with the whitening bit stream for n = N, as is.

**Whitening.** The tile bytes are XORed with an xorshift32 sequence. The state is s₀ = 0x6F707463 ⊕ (0x9E3779B9 · (n + 1) mod 2³²),
and if s₀ = 0 it is replaced by 1. One step is s ^= s << 13; s ^= s >> 17; s ^= s << 5, and byte k uses the low 8 bits after the (k + 1)-th step.
This makes the screen always look like uniform noise regardless of the file content, and it prevents large blocks from looking like finders.

**RS code.** The 128 bytes before whitening = 108 data bytes + 20 Reed–Solomon parity bytes.
GF(2⁸), primitive polynomial 0x11D, first root α⁰ (the default of the `reed-solomon` crate 0.2.1).
It corrects up to 10 byte errors or 20 byte erasures.

**108 data bytes.**

| Offset | Size | Content |
|---|---|---|
| 0 | 1 | Kind: 1 = DATA, 2 = META |
| 1 | 1 | Flags (0) |
| 2 | 2 | Tag = low 16 bits of the transfer ID |
| 4 | 1 | SBN (RaptorQ source block number) |
| 5 | 3 | ESI (RaptorQ encoding symbol ID, 24 bits) |
| 8 | 96 | Payload: a RaptorQ symbol for DATA, section 4 for META |
| 104 | 4 | CRC-32C (Castagnoli) over offsets 0..104 |

SBN and ESI of a META tile are 0.

## 4. META content (96 bytes)

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | Transfer ID = CRC-32C(META[4..96]) |
| 4 | 8 | Original file size |
| 12 | 32 | SHA-256 of the original |
| 44 | 1 | Compression: 0 = none, 1 = deflate-raw |
| 45 | 12 | RaptorQ OTI (RFC 6330 serialization, `ObjectTransmissionInformation::serialize`) |
| 57 | 1 | File name length L (≤ 38) |
| 58 | 38 | File name in UTF-8 (L bytes, the rest are 0) |

- The transfer ID depends only on the file content and the settings. Sending the same file again with the same settings gives the same ID, so symbols from before and after a restart can be combined.
- Only the base name (without the path) is used as the file name. If it exceeds 38 bytes, the extension is kept and the end of the part before the extension is cut at a UTF-8 character boundary.
  The extension starts at the last `.` (a `.` in the first position does not count). If the extension is 38 bytes or longer, or keeping it would leave the leading part empty,
  the whole name is cut without keeping the extension (so the result is not a hidden file name like `.eee…`).
- The data is compressed only if the deflate output is smaller than the original.

## 5. Symbol order

- RaptorQ symbol size T = 96, alignment Al = 8. The number of blocks Z and sub-blocks N follow `ObjectTransmissionInformation::with_defaults(F, 96)`
  (Z = ⌈K / 56403⌉, one sub-block). Since Z ≤ 255, F is at most 255 · 56403 · 96 bytes (about 1.38 GB).
- Source pass: the source symbols of all blocks (ESI < K_b) are sent once each, in round-robin block order.
- Repair: sending continues with ESI = K_b + r₀ + i (round-robin over blocks). r₀ is a random number in [0, 2²⁰) chosen at start, and when ESI reaches 2²⁴ it wraps back to K_b.
- META: one of the tiles of frame f is a META tile. It is inserted every m = max(1, ⌈10 / N⌉) frames (frames where f mod m = 0), at tile position f mod N.
  f is the frame number counted from the start of transmission (from 0), and N and m are computed from the layout of that frame.
  The position rotates so that META is not always lost in the same screen area (for example, to glare).
- Empty file: the 12 OTI bytes are all 0 (F = 0). There are no symbols to send, so every tile of every frame is a META tile.
  The receiver completes from META alone (size 0, checking the SHA-256 of empty input).

## 6. Receive rules (summary)

1. Finders → format information (W, H, profile) → grid sampling → per-tile de-whitening → RS → CRC → check kind and tag.
2. META: verify the transfer ID. A META with a different ID that arrives after one has been confirmed is only counted as "another transfer".
3. DATA: remove duplicates by (SBN, ESI) and feed the symbol to the RaptorQ decoder.
4. Reconstruct → (if compressed) inflate with the declared size as the upper limit → save only if the SHA-256 matches.
