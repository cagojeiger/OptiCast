//! Sender side (spec §4, §5): prepares a transfer (optional deflate, SHA-256,
//! RaptorQ with T = 96, Al = 8) and fills frames with tiles: the source pass,
//! then repair symbols forever, with META on a rotating tile position.

use std::fmt;
use std::io::Write;

use raptorq::{calculate_block_offsets, ObjectTransmissionInformation, SourceBlockEncoder};
use sha2::{Digest, Sha256};

use crate::layout::Layout;
use crate::meta::{truncate_filename, Compression, Meta, MAX_BLOCK_SYMBOLS, SYMBOL_SIZE};
use crate::tile::{Codeword, Tile, CONTENT_BYTES};

/// r₀ is drawn from [0, 2²⁰).
pub const R0_RANGE: u32 = 1 << 20;
/// ESIs are 24-bit.
pub(crate) const ESI_RANGE: u32 = 1 << 24;
/// Largest RaptorQ transfer length: 255 blocks of K'max symbols.
pub(crate) const MAX_PAYLOAD_BYTES: u64 = 255 * MAX_BLOCK_SYMBOLS * SYMBOL_SIZE as u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendOptions {
    /// Try deflate-raw; it is used only if the result is smaller.
    pub compress: bool,
}

impl Default for SendOptions {
    fn default() -> Self {
        SendOptions { compress: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrepareError {
    /// The (compressed) payload exceeds what one RaptorQ object can carry.
    TooLarge { bytes: u64, max: u64 },
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrepareError::TooLarge { bytes, max } => {
                write!(f, "payload of {bytes} bytes exceeds the RaptorQ limit of {max} bytes")
            }
        }
    }
}

impl std::error::Error for PrepareError {}

/// META goes into every m-th frame, m = max(1, ⌈10 / N⌉).
pub(crate) fn meta_interval(tiles: usize) -> u64 {
    10u64.div_ceil(tiles.max(1) as u64).max(1)
}

/// Average DATA tiles per frame: N − 1/m.
pub fn data_tiles_per_frame(tiles: usize) -> f64 {
    tiles as f64 - 1.0 / meta_interval(tiles) as f64
}

/// "phone needs": seconds of view to collect `symbols_needed` symbols
/// ([`Transfer::symbols_needed`]) at `fps`. For an empty file (0 needed) it is
/// the time until one META frame is shown.
pub fn view_seconds(symbols_needed: u64, tiles: usize, fps: f64) -> f64 {
    if symbols_needed == 0 {
        return meta_interval(tiles) as f64 / fps;
    }
    symbols_needed as f64 / (fps * data_tiles_per_frame(tiles))
}

/// ESI of the `i`-th repair symbol of a block with K source symbols:
/// K + r₀ + i, wrapping from 2²⁴ back to K.
pub(crate) fn repair_esi(k: u32, r0: u32, i: u64) -> u32 {
    let span = (ESI_RANGE - k) as u64;
    k + ((r0 as u64 + i) % span) as u32
}

/// The order of (SBN, ESI) pairs (spec §5): every source symbol once in block
/// round-robin order, then repair symbols from ESI K_b + r₀, also round-robin.
/// The iterator never ends.
#[derive(Clone, Debug)]
pub(crate) struct Schedule {
    block_symbols: Vec<u32>,
    r0: u32,
    phase: Phase,
    block: usize,
}

#[derive(Clone, Copy, Debug)]
enum Phase {
    Source { round: u32 },
    Repair { i: u64 },
}

impl Schedule {
    /// `block_symbols[b]` is K_b (each ≥ 1); `r0` is reduced into [0, 2²⁰).
    pub fn new(block_symbols: Vec<u32>, r0: u32) -> Schedule {
        assert!(!block_symbols.is_empty() && block_symbols.iter().all(|k| (1..ESI_RANGE).contains(k)));
        Schedule { block_symbols, r0: r0 % R0_RANGE, phase: Phase::Source { round: 0 }, block: 0 }
    }
}

impl Iterator for Schedule {
    type Item = (u8, u32);

    fn next(&mut self) -> Option<(u8, u32)> {
        let blocks = self.block_symbols.len();
        let max_k = self.block_symbols.iter().copied().max().unwrap_or(0);
        loop {
            if self.block == blocks {
                self.block = 0;
                self.phase = match self.phase {
                    Phase::Source { round } if round + 1 >= max_k => Phase::Repair { i: 0 },
                    Phase::Source { round } => Phase::Source { round: round + 1 },
                    Phase::Repair { i } => Phase::Repair { i: i + 1 },
                };
            }
            let b = self.block;
            self.block += 1;
            let k = self.block_symbols[b];
            match self.phase {
                // Blocks with fewer source symbols drop out of the last round.
                Phase::Source { round } if round < k => return Some((b as u8, round)),
                Phase::Source { .. } => continue,
                Phase::Repair { i } => return Some((b as u8, repair_esi(k, self.r0, i))),
            }
        }
    }
}

struct Block {
    /// Byte range of the block in the payload; `end` may exceed the payload (zero padding).
    start: usize,
    end: usize,
    /// Built on first use: only repair symbols need it.
    encoder: Option<SourceBlockEncoder>,
}

impl Block {
    fn symbols(&self) -> u32 {
        ((self.end - self.start) / SYMBOL_SIZE as usize) as u32
    }
}

/// One file being broadcast. Call [`Transfer::next_frame`] once per drawn frame.
pub struct Transfer {
    meta: Meta,
    meta_bytes: [u8; CONTENT_BYTES],
    /// Low 16 bits of the transfer ID, put in every tile.
    tag: u16,
    payload: Vec<u8>,
    config: Option<ObjectTransmissionInformation>,
    blocks: Vec<Block>,
    schedule: Option<Schedule>,
    frames: u64,
    source_sent: u64,
    repair_sent: u64,
}

impl Transfer {
    /// Prepares `data` for sending. `filename` is the base name (truncated to 38
    /// bytes); `r0` picks the first repair ESI and should be random per run.
    pub fn prepare(data: &[u8], filename: &str, options: SendOptions, r0: u32) -> Result<Transfer, PrepareError> {
        let sha256: [u8; 32] = Sha256::digest(data).into();
        let deflated = if options.compress && !data.is_empty() { deflate_raw(data) } else { None };
        let (payload, compression) = match deflated {
            Some(d) if d.len() < data.len() => (d, Compression::DeflateRaw),
            _ => (data.to_vec(), Compression::None),
        };
        if payload.len() as u64 > MAX_PAYLOAD_BYTES {
            return Err(PrepareError::TooLarge { bytes: payload.len() as u64, max: MAX_PAYLOAD_BYTES });
        }

        let config = (!payload.is_empty())
            .then(|| ObjectTransmissionInformation::with_defaults(payload.len() as u64, SYMBOL_SIZE));
        let blocks: Vec<Block> = match &config {
            Some(c) => {
                // with_defaults gives T = 96, Al = 8 and, at this symbol size, one sub-block.
                debug_assert!(c.symbol_size() == SYMBOL_SIZE && c.symbol_alignment() == 8 && c.sub_blocks() == 1);
                calculate_block_offsets(&payload, c)
                    .into_iter()
                    .map(|(start, end)| Block { start, end, encoder: None })
                    .collect()
            }
            None => Vec::new(),
        };
        let schedule = (!blocks.is_empty()).then(|| Schedule::new(blocks.iter().map(Block::symbols).collect(), r0));

        let meta = Meta {
            size: data.len() as u64,
            sha256,
            compression,
            oti: config.map(|c| c.serialize()).unwrap_or([0; 12]),
            filename: truncate_filename(filename),
        };
        Ok(Transfer {
            meta_bytes: meta.to_bytes(),
            tag: meta.tag(),
            meta,
            payload,
            config,
            blocks,
            schedule,
            frames: 0,
            source_sent: 0,
            repair_sent: 0,
        })
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    /// The serialized META block, as carried in META tiles.
    pub fn meta_bytes(&self) -> &[u8; CONTENT_BYTES] {
        &self.meta_bytes
    }

    pub fn id(&self) -> u32 {
        self.meta.id()
    }

    /// Bytes handed to RaptorQ (after compression).
    pub fn payload_len(&self) -> u64 {
        self.payload.len() as u64
    }

    /// Source symbols K over all blocks.
    pub fn source_symbols(&self) -> u64 {
        self.blocks.iter().map(|b| b.symbols() as u64).sum()
    }

    pub fn source_blocks(&self) -> usize {
        self.blocks.len()
    }

    /// Symbols a receiver should expect to need: K_b + 2 per block, K + 2·Z in all
    /// (0 for an empty file). Matches `Assembler::symbols_needed`.
    pub fn symbols_needed(&self) -> u64 {
        match self.source_symbols() {
            0 => 0,
            k => k + 2 * self.source_blocks() as u64,
        }
    }

    pub fn frames_sent(&self) -> u64 {
        self.frames
    }

    pub fn source_sent(&self) -> u64 {
        self.source_sent
    }

    pub fn repair_sent(&self) -> u64 {
        self.repair_sent
    }

    /// Fraction of the source pass already shown (1.0 for an empty file).
    pub fn source_progress(&self) -> f64 {
        match self.source_symbols() {
            0 => 1.0,
            k => self.source_sent as f64 / k as f64,
        }
    }

    /// Builds every block's repair encoder now instead of on first use, so the
    /// switch from the source pass to repair symbols does not stall a frame.
    pub fn prepare_repair(&mut self) {
        for sbn in 0..self.blocks.len() {
            self.encoder(sbn);
        }
    }

    /// Tiles for the next frame of a layout with `tiles` positions (unencoded).
    pub fn next_frame_tiles(&mut self, tiles: usize) -> Vec<Tile> {
        debug_assert!(tiles >= 2, "a layout has at least 2 tile positions");
        let f = self.frames;
        self.frames += 1;
        let meta = Tile::meta(self.tag, self.meta_bytes);
        if self.schedule.is_none() {
            // Empty file: there are no symbols, so every tile is META.
            return vec![meta; tiles];
        }
        let meta_at = (f % meta_interval(tiles) == 0).then_some((f % tiles as u64) as usize);
        (0..tiles).map(|n| if meta_at == Some(n) { meta.clone() } else { self.next_symbol() }).collect()
    }

    /// RS codewords (not yet whitened) for the next frame; pass them to `frame::render`.
    pub fn next_frame(&mut self, layout: &Layout) -> Vec<Codeword> {
        self.next_frame_tiles(layout.tiles()).iter().map(Tile::encode).collect()
    }

    fn next_symbol(&mut self) -> Tile {
        let (sbn, esi) = self.schedule.as_mut().and_then(Iterator::next).expect("schedule never ends");
        let (block_start, k) = {
            let block = &self.blocks[sbn as usize];
            (block.start, block.symbols())
        };
        let mut content = [0u8; CONTENT_BYTES];
        if esi < k {
            self.source_sent += 1;
            let start = block_start + esi as usize * CONTENT_BYTES;
            let end = (start + CONTENT_BYTES).min(self.payload.len());
            if start < end {
                content[..end - start].copy_from_slice(&self.payload[start..end]);
            }
        } else {
            self.repair_sent += 1;
            let packet = self.encoder(sbn as usize).repair_packets(esi - k, 1);
            content.copy_from_slice(packet[0].data());
        }
        Tile::data(self.tag, sbn, esi, content)
    }

    fn encoder(&mut self, sbn: usize) -> &SourceBlockEncoder {
        let config = self.config.as_ref().expect("blocks imply a config");
        let block = &mut self.blocks[sbn];
        let payload = &self.payload;
        block.encoder.get_or_insert_with(|| {
            let mut data = payload[block.start..block.end.min(payload.len())].to_vec();
            data.resize(block.end - block.start, 0);
            SourceBlockEncoder::new(sbn as u8, config, &data)
        })
    }
}

fn deflate_raw(data: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile::TileKind;

    #[test]
    fn source_pass_is_block_round_robin() {
        let order: Vec<_> = Schedule::new(vec![3, 3, 2], 0).take(8).collect();
        assert_eq!(order, [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1), (0, 2), (1, 2)]);
    }

    #[test]
    fn repair_follows_source_pass() {
        let r0 = 12_345;
        let mut s = Schedule::new(vec![3, 3, 2], r0);
        assert!(s.by_ref().take(8).all(|(_, esi)| esi < 3));
        let repair: Vec<_> = s.take(6).collect();
        assert_eq!(repair, [(0, 3 + r0), (1, 3 + r0), (2, 2 + r0), (0, 4 + r0), (1, 4 + r0), (2, 3 + r0)]);
    }

    #[test]
    fn repair_esi_wraps_at_24_bits() {
        let k = 100;
        let r0 = R0_RANGE - 1;
        let last = (ESI_RANGE - 1 - k - r0) as u64;
        assert_eq!(repair_esi(k, r0, 0), k + r0);
        assert_eq!(repair_esi(k, r0, last), ESI_RANGE - 1);
        assert_eq!(repair_esi(k, r0, last + 1), k);
        assert_eq!(repair_esi(k, r0, last + 2), k + 1);
        // r0 is reduced into range.
        let mut s = Schedule::new(vec![1], R0_RANGE + 5);
        assert_eq!(s.nth(1), Some((0, 1 + 5)));
    }

    #[test]
    fn meta_interval_and_position() {
        assert_eq!(meta_interval(2), 5);
        assert_eq!(meta_interval(7), 2);
        assert_eq!(meta_interval(10), 1);
        assert_eq!(meta_interval(19), 1);
        let mut t = Transfer::prepare(&[0xA5; 50_000], "a.bin", SendOptions { compress: false }, 0).unwrap();
        for f in 0..30u64 {
            let frame = t.next_frame_tiles(7);
            let metas: Vec<usize> = (0..7).filter(|&n| frame[n].kind == TileKind::Meta).collect();
            // Frame f was the f-th call; META every 2 frames at position f mod 7.
            if f % 2 == 0 {
                assert_eq!(metas, [(f % 7) as usize]);
            } else {
                assert!(metas.is_empty());
            }
        }
    }

    #[test]
    fn multi_block_schedule_covers_every_source_symbol_once() {
        // K = 56,412 > K'max needs two source blocks; 18 DATA tiles per 19-tile
        // frame divide K exactly, so no repair symbol (and no encoder) is needed.
        let k = 56_412usize;
        let data: Vec<u8> =
            (0..k * 96 - 50).map(|i| (i as u32).wrapping_mul(2_654_435_761).rotate_left(7) as u8).collect();
        let mut t = Transfer::prepare(&data, "big.bin", SendOptions { compress: false }, 7).unwrap();
        assert_eq!(t.source_blocks(), 2);
        assert_eq!(t.symbols_needed(), k as u64 + 4);
        assert_eq!(t.source_symbols(), k as u64);
        let mut seen = std::collections::HashSet::new();
        let mut first = None;
        let mut last = None;
        while seen.len() < k {
            for tile in t.next_frame_tiles(19).into_iter().filter(|t| t.kind == TileKind::Data) {
                assert!(seen.insert((tile.sbn, tile.esi)), "duplicate {:?}", (tile.sbn, tile.esi));
                first.get_or_insert_with(|| tile.clone());
                last = Some(tile);
            }
        }
        assert_eq!(t.source_sent(), k as u64);
        assert_eq!(t.repair_sent(), 0);
        assert!((t.source_progress() - 1.0).abs() < 1e-12);
        // Source symbols are the raw payload; the very last one is zero-padded.
        let first = first.unwrap();
        assert_eq!((first.sbn, first.esi), (0, 0));
        assert_eq!(&first.content[..], &data[..96]);
        let last = last.unwrap();
        assert_eq!((last.sbn, last.esi), (1, k as u32 / 2 - 1));
        assert_eq!(&last.content[..46], &data[data.len() - 46..]);
        assert!(last.content[46..].iter().all(|&b| b == 0));
    }

    #[test]
    fn compression_only_when_smaller() {
        let text = b"hello diodecam ".repeat(1000);
        let t = Transfer::prepare(&text, "t.txt", SendOptions::default(), 0).unwrap();
        assert_eq!(t.meta().compression, Compression::DeflateRaw);
        assert!(t.payload_len() < text.len() as u64);

        let tiny = Transfer::prepare(b"x", "x", SendOptions::default(), 0).unwrap();
        assert_eq!(tiny.meta().compression, Compression::None);
        assert_eq!(tiny.payload_len(), 1);

        let off = Transfer::prepare(&text, "t.txt", SendOptions { compress: false }, 0).unwrap();
        assert_eq!(off.meta().compression, Compression::None);
    }

    #[test]
    fn transfer_id_is_stable_across_restarts() {
        let data = b"same file, same settings".repeat(100);
        let a = Transfer::prepare(&data, "f", SendOptions::default(), 1).unwrap();
        let b = Transfer::prepare(&data, "f", SendOptions::default(), 999).unwrap();
        assert_eq!(a.id(), b.id());
        let c = Transfer::prepare(&data, "f", SendOptions { compress: false }, 1).unwrap();
        assert_ne!(a.id(), c.id());
    }

    #[test]
    fn empty_file_sends_only_meta() {
        let mut t = Transfer::prepare(&[], "empty.txt", SendOptions::default(), 0).unwrap();
        assert_eq!(t.source_symbols(), 0);
        assert_eq!(t.meta().oti, [0; 12]);
        assert!(t.next_frame_tiles(5).iter().all(|tile| tile.kind == TileKind::Meta));
    }

    #[test]
    fn view_time() {
        // 19 tiles → 18 DATA tiles per frame.
        assert!((view_seconds(10_000, 19, 15.0) - 10_000.0 / 270.0).abs() < 1e-9);
        assert!((view_seconds(0, 2, 10.0) - 0.5).abs() < 1e-9);
    }
}
