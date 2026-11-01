//! Receiver side (spec §6): an [`Assembler`] takes decoded tiles in any order,
//! confirms the transfer from META, de-duplicates (SBN, ESI), feeds RaptorQ and
//! finally verifies size and SHA-256.
//!
//! Everything on screen is untrusted: a META can declare any size, so the
//! assembler refuses transfers above its size limit before allocating anything
//! for them, and inflates into a buffer bounded by the declared size.

use std::collections::HashSet;
use std::fmt;
use std::io::{self, Read};

use raptorq::{Decoder, EncodingPacket, PayloadId};
use sha2::{Digest, Sha256};

use crate::meta::{Compression, Meta};
use crate::tile::{Tile, TileKind};

/// DATA tiles kept while waiting for the first META.
const MAX_PENDING: usize = 1 << 16;

/// Largest file (and RaptorQ payload) accepted by default: 64 MiB, the sender's
/// default `--max-bytes`.
pub const DEFAULT_MAX_FILE: u64 = 64 << 20;

/// What [`Assembler::accept`] did with a tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accepted {
    /// The first valid META: the transfer is now confirmed.
    MetaConfirmed,
    /// A repeat of the confirmed META.
    MetaRepeat,
    /// A new symbol went into the decoder.
    Symbol,
    /// This symbol completed decoding.
    Complete,
    /// Already have this (SBN, ESI), or the transfer is already complete.
    Duplicate,
    /// DATA before any META; held until META arrives.
    Pending,
    /// Belongs to a different transfer (other tag or ID).
    OtherTransfer,
    /// Failed META validation, an SBN outside the OTI, or a META that already
    /// proved self-contradictory.
    Invalid,
    /// META (or DATA) of a transfer larger than the size limit: refused, see
    /// [`Assembler::refused`].
    TooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiveError {
    /// Not enough symbols yet.
    Incomplete,
    /// The decoded payload is not valid deflate data.
    Inflate,
    /// The restored file does not have the declared size.
    SizeMismatch { expected: u64, actual: u64 },
    /// SHA-256 differs: the file is not saved.
    HashMismatch,
    /// Not enough memory to restore the file. The decoded payload is kept, so a
    /// later [`Assembler::finalize`] can try again.
    OutOfMemory,
    /// The declared size exceeds the receiver's limit (lowered after META was
    /// confirmed). The payload is kept.
    TooLarge { size: u64, limit: u64 },
    /// An earlier [`Assembler::finalize`] already returned the file.
    Taken,
}

impl ReceiveError {
    /// Whether this failure discards the decode and starts collecting afresh:
    /// only when the decoded data itself is wrong (deflate format, size, SHA-256).
    pub fn restarts(&self) -> bool {
        matches!(self, ReceiveError::Inflate | ReceiveError::SizeMismatch { .. } | ReceiveError::HashMismatch)
    }
}

impl fmt::Display for ReceiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReceiveError::Incomplete => f.write_str("transfer not complete"),
            ReceiveError::Inflate => f.write_str("payload does not inflate"),
            ReceiveError::SizeMismatch { expected, actual } => {
                write!(f, "size mismatch: expected {expected} bytes, got {actual}")
            }
            ReceiveError::HashMismatch => f.write_str("SHA-256 mismatch"),
            ReceiveError::OutOfMemory => f.write_str("not enough memory to restore the file"),
            ReceiveError::TooLarge { size, limit } => {
                write!(f, "file of {size} bytes exceeds the limit of {limit} bytes")
            }
            ReceiveError::Taken => f.write_str("file already returned"),
        }
    }
}

impl std::error::Error for ReceiveError {}

/// Counters for a receiver UI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Distinct symbols given to the current decoder (restarts with it).
    pub symbols: u64,
    pub duplicates: u64,
    pub other_transfer: u64,
    pub invalid: u64,
    /// Decodes that completed but failed verification (wrong size or SHA-256,
    /// or bad deflate data) and were restarted. A 16-bit tag collision with
    /// another transfer on screen can feed the decoder foreign symbols.
    pub failed: u64,
    /// META tiles refused because the transfer exceeds the size limit.
    pub too_large: u64,
}

/// Reassembles one transfer from decoded tiles.
pub struct Assembler {
    meta: Option<Meta>,
    /// Largest file size and RaptorQ transfer length accepted.
    limit: u64,
    /// The last META refused as too large: (transfer ID, declared size).
    refused: Option<(u32, u64)>,
    /// Empty-file METAs that failed verification (self-contradictory): never confirmed again.
    bad: HashSet<u32>,
    /// `finalize` returned the file; the payload has moved out.
    finished: bool,
    /// Transfer ID of the confirmed META and its low 16 bits (the tile tag),
    /// cached because every DATA tile is checked against it.
    id: u32,
    tag: u16,
    source_blocks: u8,
    decoder: Option<Decoder>,
    seen: HashSet<(u8, u32)>,
    pending: Vec<Tile>,
    payload: Option<Vec<u8>>,
    stats: Stats,
}

impl Default for Assembler {
    fn default() -> Self {
        Assembler::with_limit(DEFAULT_MAX_FILE)
    }
}

impl Assembler {
    pub fn new() -> Assembler {
        Assembler::default()
    }

    /// An assembler that refuses files (and RaptorQ payloads) above `limit` bytes.
    pub fn with_limit(limit: u64) -> Assembler {
        Assembler {
            meta: None,
            limit,
            refused: None,
            bad: HashSet::new(),
            finished: false,
            id: 0,
            tag: 0,
            source_blocks: 0,
            decoder: None,
            seen: HashSet::new(),
            pending: Vec::new(),
            payload: None,
            stats: Stats::default(),
        }
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    /// Changes the limit for METAs still to come; a confirmed transfer above it
    /// fails [`Assembler::finalize`] with [`ReceiveError::TooLarge`].
    pub fn set_limit(&mut self, limit: u64) {
        self.limit = limit;
    }

    /// The last META refused for its size: (transfer ID, declared size in bytes).
    pub fn refused(&self) -> Option<(u32, u64)> {
        self.refused
    }

    /// Takes one tile that passed `tile::decode`.
    pub fn accept(&mut self, tile: &Tile) -> Accepted {
        let result = match tile.kind {
            TileKind::Meta => self.accept_meta(tile),
            TileKind::Data => self.accept_data(tile),
        };
        self.count(result);
        result
    }

    fn count(&mut self, result: Accepted) {
        match result {
            Accepted::Duplicate => self.stats.duplicates += 1,
            Accepted::OtherTransfer => self.stats.other_transfer += 1,
            Accepted::Invalid => self.stats.invalid += 1,
            _ => {}
        }
    }

    fn accept_meta(&mut self, tile: &Tile) -> Accepted {
        let Ok(meta) = Meta::from_bytes(&tile.content) else { return Accepted::Invalid };
        // from_bytes checked that bytes 0..4 hold the transfer ID.
        let id = u32::from_be_bytes([tile.content[0], tile.content[1], tile.content[2], tile.content[3]]);
        if tile.tag != id as u16 {
            return Accepted::Invalid;
        }
        if self.meta.is_some() {
            return if self.id == id { Accepted::MetaRepeat } else { Accepted::OtherTransfer };
        }
        if self.bad.contains(&id) {
            return Accepted::Invalid;
        }
        // Refuse before the decoder allocates anything for it. For deflate the
        // declared size bounds the inflated output, so it must fit too.
        let declared = meta.size.max(meta.transfer_length());
        if declared > self.limit {
            self.refused = Some((id, declared));
            self.stats.too_large += 1;
            self.pending.retain(|t| t.tag != id as u16);
            return Accepted::TooLarge;
        }
        self.id = id;
        self.tag = id as u16;
        self.meta = Some(meta);
        self.start_decoder();
        // Replay DATA that arrived first, counted like any other tile.
        let mut result = Accepted::MetaConfirmed;
        for held in std::mem::take(&mut self.pending) {
            let r = self.accept_data(&held);
            self.count(r);
            if r == Accepted::Complete {
                result = Accepted::Complete;
            }
        }
        result
    }

    /// A fresh decoder for the confirmed META (or the empty payload of an empty file).
    fn start_decoder(&mut self) {
        let Some(meta) = &self.meta else { return };
        self.seen.clear();
        self.stats.symbols = 0;
        self.payload = None;
        self.decoder = None;
        match meta.oti() {
            Some(oti) => {
                self.source_blocks = oti.source_blocks();
                self.decoder = Some(Decoder::new(oti));
            }
            None => self.payload = Some(Vec::new()),
        }
    }

    fn accept_data(&mut self, tile: &Tile) -> Accepted {
        if self.meta.is_none() {
            if self.refused.is_some_and(|(id, _)| id as u16 == tile.tag) {
                return Accepted::TooLarge; // its META was refused: do not hold its symbols
            }
            if self.pending.len() < MAX_PENDING {
                self.pending.push(tile.clone());
            }
            return Accepted::Pending;
        }
        if tile.tag != self.tag {
            return Accepted::OtherTransfer;
        }
        if self.payload.is_some() || self.finished {
            return Accepted::Duplicate;
        }
        // The decoder indexes blocks by SBN; reject anything outside the OTI.
        let Some(decoder) = self.decoder.as_mut().filter(|_| tile.sbn < self.source_blocks) else {
            return Accepted::Invalid;
        };
        if !self.seen.insert((tile.sbn, tile.esi)) {
            return Accepted::Duplicate;
        }
        self.stats.symbols += 1;
        let packet = EncodingPacket::new(PayloadId::new(tile.sbn, tile.esi), tile.content.to_vec());
        match decoder.decode(packet) {
            Some(payload) => {
                self.payload = Some(payload);
                self.decoder = None; // free the decoding matrices
                Accepted::Complete
            }
            None => Accepted::Symbol,
        }
    }

    /// The confirmed META, if any.
    pub fn meta(&self) -> Option<&Meta> {
        self.meta.as_ref()
    }

    pub fn transfer_id(&self) -> Option<u32> {
        self.meta.as_ref().map(|_| self.id)
    }

    /// RaptorQ has recovered the payload (or the file is empty), or the file was
    /// already returned by [`Assembler::finalize`].
    pub fn is_complete(&self) -> bool {
        self.payload.is_some() || self.finished
    }

    /// Symbols a receiver should expect to need: K + 2.
    pub fn symbols_needed(&self) -> Option<u64> {
        self.meta.as_ref().map(|m| m.source_symbols() + 2)
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// The restored file, moved out of the assembler: inflates (into a buffer
    /// bounded by the declared size) if needed and returns it only if both the
    /// size and the SHA-256 match META.
    ///
    /// When the decoded data is wrong ([`ReceiveError::restarts`]) the decode is
    /// restarted from scratch (the symbols that produced it cannot be told apart)
    /// and counted in [`Stats::failed`]; keep feeding tiles and fresh symbols
    /// complete it again. An empty file fails only if its META is
    /// self-contradictory; then that META is dropped and refused from then on.
    /// Running out of memory, or a size above a lowered limit, keeps the payload.
    pub fn finalize(&mut self) -> Result<Vec<u8>, ReceiveError> {
        if self.finished {
            return Err(ReceiveError::Taken);
        }
        let Some(meta) = &self.meta else { return Err(ReceiveError::Incomplete) };
        let (size, sha256, compression) = (meta.size, meta.sha256, meta.compression);
        let Some(payload) = self.payload.take() else { return Err(ReceiveError::Incomplete) };
        if size > self.limit {
            self.payload = Some(payload);
            return Err(ReceiveError::TooLarge { size, limit: self.limit });
        }
        let data = match compression {
            Compression::None => payload,
            Compression::DeflateRaw => match inflate(&payload, size) {
                Ok(data) => data,
                Err(Inflated::Memory) => {
                    self.payload = Some(payload);
                    return Err(ReceiveError::OutOfMemory);
                }
                Err(Inflated::TooLong) => {
                    return self.fail(ReceiveError::SizeMismatch { expected: size, actual: size.saturating_add(1) })
                }
                Err(Inflated::Format) => return self.fail(ReceiveError::Inflate),
            },
        };
        if data.len() as u64 != size {
            return self.fail(ReceiveError::SizeMismatch { expected: size, actual: data.len() as u64 });
        }
        if <[u8; 32]>::from(Sha256::digest(&data)) != sha256 {
            return self.fail(ReceiveError::HashMismatch);
        }
        self.finished = true;
        Ok(data)
    }

    /// The decoded data is wrong: count it and start over.
    fn fail(&mut self, e: ReceiveError) -> Result<Vec<u8>, ReceiveError> {
        debug_assert!(e.restarts());
        self.stats.failed += 1;
        if self.meta.as_ref().is_some_and(Meta::is_empty_file) {
            self.bad.insert(self.id);
            self.meta = None;
            self.payload = None;
        } else {
            self.start_decoder();
        }
        Err(e)
    }
}

enum Inflated {
    /// Not valid deflate data.
    Format,
    /// More output than the declared size.
    TooLong,
    /// The output buffer could not be allocated.
    Memory,
}

/// Inflates into one allocation of exactly `size` bytes (never grown), reading
/// at most `size + 1` bytes of output.
fn inflate(payload: &[u8], size: u64) -> Result<Vec<u8>, Inflated> {
    let cap = usize::try_from(size).map_err(|_| Inflated::Memory)?;
    let mut out = Vec::new();
    out.try_reserve_exact(cap).map_err(|_| Inflated::Memory)?;
    let mut decoder = flate2::read::DeflateDecoder::new(payload).take(size.saturating_add(1));
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match decoder.read(&mut chunk) {
            Ok(0) => return Ok(out),
            Ok(n) if out.len() + n > cap => return Err(Inflated::TooLong),
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::OutOfMemory => return Err(Inflated::Memory),
            Err(_) => return Err(Inflated::Format),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sender::{SendOptions, Transfer};

    fn tiles_of(t: &mut Transfer, frames: usize) -> Vec<Tile> {
        (0..frames).flat_map(|_| t.next_frame_tiles(7)).collect()
    }

    #[test]
    fn data_before_meta_is_held() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i * 7 + i / 3) as u8).collect();
        let mut tx = Transfer::prepare(&data, "a", SendOptions { compress: false }, 0).unwrap();
        let mut tiles = tiles_of(&mut tx, 40);
        // Put META last.
        tiles.sort_by_key(|t| t.kind == TileKind::Meta);
        let mut rx = Assembler::new();
        for t in &tiles {
            rx.accept(t);
            if rx.is_complete() {
                break;
            }
        }
        assert_eq!(rx.finalize(), Ok(data));
    }

    #[test]
    fn other_transfers_are_counted_not_mixed() {
        let mut a = Transfer::prepare(b"first file", "a", SendOptions::default(), 0).unwrap();
        let mut b = Transfer::prepare(b"second file", "b", SendOptions::default(), 0).unwrap();
        let mut rx = Assembler::new();
        assert_eq!(rx.accept(&a.next_frame_tiles(2)[0]), Accepted::MetaConfirmed);
        let b_tiles = b.next_frame_tiles(2);
        assert_eq!(rx.accept(&b_tiles[0]), Accepted::OtherTransfer);
        assert_eq!(rx.accept(&b_tiles[1]), Accepted::OtherTransfer);
        assert_eq!(rx.stats().other_transfer, 2);
    }

    #[test]
    fn tampered_meta_is_invalid() {
        let mut t = Transfer::prepare(b"abc", "a", SendOptions::default(), 0).unwrap();
        let mut meta = t.next_frame_tiles(2)[0].clone();
        meta.content[30] ^= 1;
        assert_eq!(Assembler::new().accept(&meta), Accepted::Invalid);
    }

    #[test]
    fn wrong_hash_is_refused() {
        let mut t = Transfer::prepare(b"abc", "a", SendOptions { compress: false }, 0).unwrap();
        let tiles = t.next_frame_tiles(2);
        let mut bad = tiles[1].clone();
        bad.content[0] ^= 1;
        let mut rx = Assembler::new();
        rx.accept(&tiles[0]);
        assert_eq!(rx.accept(&bad), Accepted::Complete);
        assert_eq!(rx.finalize(), Err(ReceiveError::HashMismatch));
        // The decode restarts instead of sticking at "complete".
        assert!(!rx.is_complete());
        assert_eq!(rx.stats().failed, 1);
        assert_eq!(rx.stats().symbols, 0);
        assert_eq!(rx.accept(&tiles[1]), Accepted::Complete);
        assert_eq!(rx.finalize().as_deref(), Ok(&b"abc"[..]));
    }

    /// Tags are 16 bits: another transfer on screen can share ours. Its symbol
    /// poisons the decode; verification fails, the decode restarts, and fresh
    /// repair symbols finish it.
    #[test]
    fn tag_collision_restarts_the_decode() {
        let data: Vec<u8> = (0..3000u32).map(|i| (i * 31 + i / 7) as u8).collect();
        let mut tx = Transfer::prepare(&data, "a", SendOptions { compress: false }, 0).unwrap();
        let tag = tx.meta().tag();
        let mut rx = Assembler::new();
        let first = tx.next_frame_tiles(7);
        assert_eq!(first[0].kind, TileKind::Meta);
        assert_eq!(rx.accept(&first[0]), Accepted::MetaConfirmed);
        let foreign = Tile::data(tag, 0, 0, [0xA5; 96]);
        assert_eq!(rx.accept(&foreign), Accepted::Symbol);
        let mut frames = 0;
        for t in &first[1..] {
            rx.accept(t);
        }
        while !rx.is_complete() {
            for t in tx.next_frame_tiles(7) {
                rx.accept(&t);
            }
            frames += 1;
            assert!(frames < 100);
        }
        assert_eq!(rx.finalize(), Err(ReceiveError::HashMismatch));
        assert_eq!(rx.stats().failed, 1);
        assert!(!rx.is_complete());
        while !rx.is_complete() {
            for t in tx.next_frame_tiles(7) {
                let r = rx.accept(&t);
                assert!(rx.is_complete() || r != Accepted::Duplicate, "restarted decoder takes every new symbol");
            }
            frames += 1;
            assert!(frames < 200);
        }
        assert_eq!(rx.finalize(), Ok(data));
        assert_eq!(rx.stats().failed, 1);
    }

    /// A forged META for `payload` (already compressed or not) with any declared
    /// size and hash, plus all its source symbols.
    fn forged(payload: &[u8], meta: Meta) -> (Tile, Vec<Tile>) {
        let meta = Meta {
            oti: raptorq::ObjectTransmissionInformation::with_defaults(payload.len() as u64, 96).serialize(),
            ..meta
        };
        let bytes = meta.to_bytes();
        let tag = Meta::from_bytes(&bytes).unwrap().tag();
        let encoder = raptorq::Encoder::new(payload, meta.oti().unwrap());
        let data = encoder
            .get_encoded_packets(0)
            .into_iter()
            .map(|p| {
                let id = p.payload_id();
                Tile::data(tag, id.source_block_number(), id.encoding_symbol_id(), p.data().try_into().unwrap())
            })
            .collect();
        (Tile::meta(tag, bytes), data)
    }

    fn sample_meta(size: u64, compression: Compression) -> Meta {
        Meta { size, sha256: [7; 32], compression, oti: [0; 12], filename: "x".into() }
    }

    #[test]
    fn oversized_meta_is_refused_before_allocating() {
        // The protocol's largest transfer (255 blocks), declared by one META.
        let f = 255 * 56_403 * 96u64;
        let meta = Meta {
            oti: raptorq::ObjectTransmissionInformation::new(f, 96, 255, 1, 8).serialize(),
            ..sample_meta(f, Compression::None)
        };
        let bytes = meta.to_bytes();
        let tile = Tile::meta(Meta::from_bytes(&bytes).unwrap().tag(), bytes);
        let mut rx = Assembler::new();
        let held = Tile::data(tile.tag, 0, 1, [0; 96]);
        assert_eq!(rx.accept(&held), Accepted::Pending);
        assert_eq!(rx.accept(&tile), Accepted::TooLarge);
        assert!(rx.meta().is_none() && !rx.is_complete());
        assert_eq!(rx.refused(), Some((u32::from_be_bytes(bytes[..4].try_into().unwrap()), f)));
        assert_eq!(rx.stats().too_large, 1);
        // Its symbols are not held either.
        assert_eq!(rx.accept(&held), Accepted::TooLarge);
        // A deflate META may not declare an inflated size above the limit either.
        let (meta, _) = forged(&[1; 500], sample_meta(DEFAULT_MAX_FILE + 1, Compression::DeflateRaw));
        assert_eq!(Assembler::new().accept(&meta), Accepted::TooLarge);
        // The limit is configurable.
        let (meta, _) = forged(&[1; 5000], sample_meta(5000, Compression::None));
        assert_eq!(Assembler::with_limit(4999).accept(&meta), Accepted::TooLarge);
        assert_eq!(Assembler::with_limit(5000).accept(&meta), Accepted::MetaConfirmed);
    }

    #[test]
    fn deflate_output_is_bounded_by_the_declared_size() {
        // 4 MB of zeros deflate to a few kB; META claims 1000 bytes.
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        std::io::Write::write_all(&mut enc, &vec![0u8; 4_000_000]).unwrap();
        let payload = enc.finish().unwrap();
        let (meta, data) = forged(&payload, sample_meta(1000, Compression::DeflateRaw));
        let mut rx = Assembler::new();
        rx.accept(&meta);
        for t in &data {
            rx.accept(t);
        }
        assert!(rx.is_complete());
        assert_eq!(rx.finalize(), Err(ReceiveError::SizeMismatch { expected: 1000, actual: 1001 }));
        assert_eq!(rx.stats().failed, 1, "wrong data restarts the decode");
        assert!(!rx.is_complete());
        // Not deflate at all: a format error, which also restarts.
        let (meta, data) = forged(&[0xFF; 300], sample_meta(1000, Compression::DeflateRaw));
        let mut rx = Assembler::new();
        rx.accept(&meta);
        for t in &data {
            rx.accept(t);
        }
        assert_eq!(rx.finalize(), Err(ReceiveError::Inflate));
        assert_eq!(rx.stats().failed, 1);
    }

    #[test]
    fn out_of_memory_keeps_the_payload() {
        // A declared size no allocator can provide (above isize::MAX).
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut enc, b"hello").unwrap();
        let payload = enc.finish().unwrap();
        let (meta, data) = forged(&payload, sample_meta(1 << 63, Compression::DeflateRaw));
        let mut rx = Assembler::with_limit(u64::MAX);
        assert_eq!(rx.accept(&meta), Accepted::MetaConfirmed);
        for t in &data {
            rx.accept(t);
        }
        for _ in 0..3 {
            assert_eq!(rx.finalize(), Err(ReceiveError::OutOfMemory));
            assert!(rx.is_complete(), "the decoded payload is kept for another try");
        }
        assert_eq!(rx.stats().failed, 0, "a resource failure is not a wrong decode");
        // Lowering the limit below a confirmed size refuses to restore, also without restarting.
        rx.set_limit(10);
        assert_eq!(rx.finalize(), Err(ReceiveError::TooLarge { size: 1 << 63, limit: 10 }));
        assert!(rx.is_complete());
        assert!(!ReceiveError::OutOfMemory.restarts() && ReceiveError::HashMismatch.restarts());
    }

    #[test]
    fn finalize_moves_the_file_out_once() {
        let mut t = Transfer::prepare(b"abc", "a", SendOptions { compress: false }, 0).unwrap();
        let mut rx = Assembler::new();
        for tile in t.next_frame_tiles(2) {
            rx.accept(&tile);
        }
        assert_eq!(rx.finalize().as_deref(), Ok(&b"abc"[..]));
        assert!(rx.is_complete());
        assert_eq!(rx.finalize(), Err(ReceiveError::Taken));
        assert_eq!(rx.accept(&t.next_frame_tiles(2)[1]), Accepted::Duplicate);
    }

    #[test]
    fn self_contradictory_empty_meta_is_refused_after_it_fails() {
        // F = 0 (empty file) but a SHA-256 that is not of the empty input.
        let meta = sample_meta(0, Compression::None);
        let bytes = meta.to_bytes();
        let tile = Tile::meta(Meta::from_bytes(&bytes).unwrap().tag(), bytes);
        let mut rx = Assembler::new();
        assert_eq!(rx.accept(&tile), Accepted::MetaConfirmed);
        assert!(rx.is_complete());
        assert_eq!(rx.finalize(), Err(ReceiveError::HashMismatch));
        assert!(rx.meta().is_none() && !rx.is_complete());
        for _ in 0..10 {
            assert_eq!(rx.accept(&tile), Accepted::Invalid);
        }
        assert_eq!(rx.stats().failed, 1);
        // A genuine empty transfer still completes.
        let mut t = Transfer::prepare(&[], "e", SendOptions::default(), 0).unwrap();
        assert_eq!(rx.accept(&t.next_frame_tiles(2)[0]), Accepted::MetaConfirmed);
        assert_eq!(rx.finalize(), Ok(Vec::new()));
    }

    #[test]
    fn replayed_tiles_complete_and_are_counted() {
        let data: Vec<u8> = (0..2000u32).map(|i| (i * 13) as u8).collect();
        let mut tx = Transfer::prepare(&data, "a", SendOptions { compress: false }, 0).unwrap();
        let mut other = Transfer::prepare(b"other", "b", SendOptions::default(), 0).unwrap();
        let mut tiles = tiles_of(&mut tx, 5);
        let meta = tiles.iter().find(|t| t.kind == TileKind::Meta).unwrap().clone();
        tiles.retain(|t| t.kind == TileKind::Data);
        let k = tx.source_symbols() as usize;
        assert!(tiles.len() >= k);
        let mut rx = Assembler::new();
        rx.accept(&tiles[0]);
        rx.accept(&tiles[0]); // a repeat
        let foreign = other.next_frame_tiles(2).into_iter().find(|t| t.kind == TileKind::Data).unwrap();
        assert_eq!(rx.accept(&foreign), Accepted::Pending);
        for t in &tiles[1..k] {
            assert_eq!(rx.accept(t), Accepted::Pending);
        }
        assert_eq!(rx.accept(&meta), Accepted::Complete, "the replay finished the decode");
        let stats = rx.stats();
        assert_eq!((stats.duplicates, stats.other_transfer, stats.symbols), (1, 1, k as u64));
        assert_eq!(rx.transfer_id(), Some(tx.id()));
        assert_eq!(rx.finalize(), Ok(data));
    }
}
