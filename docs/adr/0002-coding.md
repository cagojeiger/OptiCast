# ADR 0002: Coding — RS + CRC inside a tile, RaptorQ across tiles, META

- Status: Accepted
- Date: 2026-11-01

## Context

The camera often misreads modules (blur, noise, glare) and misses whole frames (tearing, out of view, shake).
The channel is one-way, so missing pieces cannot be requested again, and the receiver does not know when it will join.

## Decision

- **Inside a tile**: 108 B of data (kind, flags, tag, SBN, ESI, 96 B payload, CRC-32C) + 20 B of Reed–Solomon parity
  (GF(2⁸), 0x11D). It corrects up to 10 byte errors, and the CRC discards tiles that were corrected wrongly. Whitening uses xorshift32.
- **Across tiles**: RaptorQ (RFC 6330, `raptorq` =2.0.1, 96 B symbols). After one pass of the source symbols, it generates repair symbols
  that mix many sources, without end (ESI = K_b + r₀ + i, r₀ is random per run). The receiver reconstructs the file once it collects any K + 2 symbols.
- **META** (transfer ID, size, SHA-256, compression, OTI, name) is inserted as one tile every m = max(1, ⌈10/N⌉) frames, and its position rotates.
  The transfer ID = CRC-32C(META[4..]), so sending the same file again gives the same ID. Deflate is used only when it makes the data smaller.
- The file is released only when both the size and the SHA-256 match.

## Rationale

- Plain repetition (v1) takes several passes while waiting for the last piece. With K = 171,012 and 10% loss, 99% completion takes 7 to 8 passes,
  while the fountain code takes about 1.11 passes. Inter-frame RS has a fixed code rate, LT codes need many extra symbols, and Wirehair is C++.
- **Even if no source symbol is received and only repair symbols arrive, decoding works from K symbols**: 343 runs with K = 100 to 42,753, and 0 extra symbols even at 16.9 MB (4 blocks).
  Joining 1 hour or 10 hours later also reconstructed the file.
- With CRC only and no RS, a few module errors would lose most of a tile. For short 128 B blocks, RS is simpler than LDPC,
  and it fits better than BCH because errors cluster in bytes.

## Consequences

- Which symbols were missed does not matter, only the count. Time needed = (K + 2) ÷ symbols received per second.
- The receiver keeps the whole block in memory → there is a size limit (default 64 MiB). `raptorq` is pinned to =2.0.1 to stay compatible with the symbol generation rules.
- If a different transfer whose 16-bit tag happens to match (1/65,536) keeps being seen, completion is delayed. A wrong file is blocked by the SHA-256.
