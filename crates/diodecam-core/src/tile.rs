//! Tiles (spec §3): 108 data bytes + 20 Reed–Solomon parity bytes = one 128-byte
//! codeword per 1024 data modules, whitened by position before it is drawn.
//!
//! Sender: [`Tile::encode`] → [`whiten`] (done by `frame::render`).
//! Receiver: raw on-screen bytes → [`decode`] (de-whiten → RS → CRC-32C → parse).

use std::fmt;

/// Bytes per tile codeword on screen.
pub const CODEWORD_BYTES: usize = 128;
/// RS message bytes.
pub const DATA_BYTES: usize = 108;
/// RS parity bytes: corrects 10 byte errors or 20 erasures.
pub const PARITY_BYTES: usize = CODEWORD_BYTES - DATA_BYTES;
/// Content bytes per tile: one RaptorQ symbol (T = 96) or the META block.
pub const CONTENT_BYTES: usize = 96;

/// One 128-byte RS codeword.
pub type Codeword = [u8; CODEWORD_BYTES];

/// Tile type byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TileKind {
    /// A RaptorQ encoding symbol.
    Data = 1,
    /// The 96-byte META block (spec §4).
    Meta = 2,
}

/// A decoded tile (spec §3, "데이터 108바이트").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tile {
    pub kind: TileKind,
    /// Low 16 bits of the transfer ID.
    pub tag: u16,
    /// RaptorQ source block number (0 for META).
    pub sbn: u8,
    /// RaptorQ encoding symbol ID, 24 bits (0 for META).
    pub esi: u32,
    pub content: [u8; CONTENT_BYTES],
}

/// Why a codeword did not yield a tile. Every failure is a rejection; a tile is
/// never returned unless its CRC-32C matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileError {
    /// More errors than RS can correct.
    Uncorrectable,
    /// RS produced a codeword but the CRC-32C does not match (miscorrection or garbage).
    BadCrc,
    /// CRC passed but the type byte is neither DATA nor META.
    UnknownKind(u8),
}

impl fmt::Display for TileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TileError::Uncorrectable => f.write_str("too many errors for Reed-Solomon"),
            TileError::BadCrc => f.write_str("CRC-32C mismatch"),
            TileError::UnknownKind(k) => write!(f, "unknown tile type {k}"),
        }
    }
}

impl std::error::Error for TileError {}

impl Tile {
    pub fn data(tag: u16, sbn: u8, esi: u32, content: [u8; CONTENT_BYTES]) -> Tile {
        debug_assert!(esi < 1 << 24);
        Tile { kind: TileKind::Data, tag, sbn, esi, content }
    }

    pub fn meta(tag: u16, content: [u8; CONTENT_BYTES]) -> Tile {
        Tile { kind: TileKind::Meta, tag, sbn: 0, esi: 0, content }
    }

    /// The 108 data bytes: header, content, CRC-32C over bytes 0..104.
    pub fn to_bytes(&self) -> [u8; DATA_BYTES] {
        let mut d = [0u8; DATA_BYTES];
        d[0] = self.kind as u8;
        d[1] = 0; // flags
        d[2..4].copy_from_slice(&self.tag.to_be_bytes());
        d[4] = self.sbn;
        d[5..8].copy_from_slice(&self.esi.to_be_bytes()[1..]);
        d[8..104].copy_from_slice(&self.content);
        let crc = crate::crc32c(&d[..104]);
        d[104..].copy_from_slice(&crc.to_be_bytes());
        d
    }

    /// Parses the 108 data bytes after checking the CRC-32C. The flags byte is ignored.
    pub fn from_bytes(d: &[u8; DATA_BYTES]) -> Result<Tile, TileError> {
        let crc = u32::from_be_bytes([d[104], d[105], d[106], d[107]]);
        if crate::crc32c(&d[..104]) != crc {
            return Err(TileError::BadCrc);
        }
        let kind = match d[0] {
            1 => TileKind::Data,
            2 => TileKind::Meta,
            k => return Err(TileError::UnknownKind(k)),
        };
        Ok(Tile {
            kind,
            tag: u16::from_be_bytes([d[2], d[3]]),
            sbn: d[4],
            esi: u32::from_be_bytes([0, d[5], d[6], d[7]]),
            content: d[8..104].try_into().expect("96-byte slice"),
        })
    }

    /// RS(128,108) codeword, not yet whitened.
    pub fn encode(&self) -> Codeword {
        let encoded = reed_solomon::Encoder::new(PARITY_BYTES).encode(&self.to_bytes());
        let mut cw = [0u8; CODEWORD_BYTES];
        cw.copy_from_slice(&encoded);
        cw
    }

    /// Corrects and parses an un-whitened codeword. Returns the tile and the
    /// number of byte errors RS corrected.
    pub fn decode_codeword(cw: &Codeword) -> Result<(Tile, usize), TileError> {
        let (fixed, errors) = reed_solomon::Decoder::new(PARITY_BYTES)
            .correct_err_count(cw, None)
            .map_err(|_| TileError::Uncorrectable)?;
        let data: &[u8; DATA_BYTES] = fixed.data().try_into().map_err(|_| TileError::Uncorrectable)?;
        Ok((Tile::from_bytes(data)?, errors))
    }
}

/// Receiver entry point: decodes the raw (whitened) bytes read from tile
/// position `n` of a frame — de-whiten → RS → CRC-32C → parse.
pub fn decode(raw: &Codeword, n: usize) -> Result<Tile, TileError> {
    let mut cw = *raw;
    whiten(&mut cw, n);
    Tile::decode_codeword(&cw).map(|(tile, _)| tile)
}

/// The whitening byte stream for tile position `n` (spec §3): xorshift32 seeded
/// with 0x6F707463 ⊕ (0x9E3779B9 · (n + 1)), byte k = low 8 bits of step k + 1.
pub fn whitening(n: usize) -> impl Iterator<Item = u8> {
    let mut s = 0x6F70_7463u32 ^ 0x9E37_79B9u32.wrapping_mul(n as u32 + 1);
    if s == 0 {
        s = 1;
    }
    std::iter::repeat_with(move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s as u8
    })
}

/// XORs `bytes` with the whitening stream of position `n`. Applying it twice
/// restores the input.
pub fn whiten(bytes: &mut [u8], n: usize) {
    for (b, w) in bytes.iter_mut().zip(whitening(n)) {
        *b ^= w;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // splitmix64
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn sample_tile(rng: &mut Rng) -> Tile {
        let content = std::array::from_fn(|_| rng.next() as u8);
        if rng.below(4) == 0 {
            Tile::meta(rng.next() as u16, content)
        } else {
            Tile::data(rng.next() as u16, rng.next() as u8, rng.next() as u32 & 0xFF_FFFF, content)
        }
    }

    /// Corrupts `count` distinct byte positions with a nonzero XOR.
    fn corrupt(cw: &mut Codeword, count: usize, rng: &mut Rng) {
        let mut positions: Vec<usize> = (0..CODEWORD_BYTES).collect();
        for i in 0..count {
            let j = i + rng.below(CODEWORD_BYTES - i);
            positions.swap(i, j);
            cw[positions[i]] ^= 1 + rng.below(255) as u8;
        }
    }

    #[test]
    fn whitening_known_answer() {
        let first: Vec<u8> = whitening(0).take(8).collect();
        assert_eq!(first, [0x24, 0x0c, 0xc7, 0xda, 0x46, 0x74, 0xef, 0x95]);
        assert_ne!(whitening(1).take(16).collect::<Vec<_>>(), whitening(0).take(16).collect::<Vec<_>>());
        let mut b = [7u8; 128];
        whiten(&mut b, 3);
        whiten(&mut b, 3);
        assert_eq!(b, [7u8; 128]);
    }

    #[test]
    fn round_trip() {
        let mut rng = Rng(1);
        for n in 0..200 {
            let tile = sample_tile(&mut rng);
            let cw = tile.encode();
            assert_eq!(&cw[..DATA_BYTES], &tile.to_bytes()[..], "systematic");
            assert_eq!(Tile::decode_codeword(&cw), Ok((tile.clone(), 0)));
            let mut raw = cw;
            whiten(&mut raw, n);
            assert_eq!(decode(&raw, n), Ok(tile.clone()));
            // Wrong position → wrong whitening → rejected.
            assert!(decode(&raw, n + 1).is_err());
        }
    }

    #[test]
    fn corrects_up_to_ten_byte_errors() {
        let mut rng = Rng(2);
        for trial in 0..2000 {
            let tile = sample_tile(&mut rng);
            let mut cw = tile.encode();
            let count = 1 + trial % 10;
            corrupt(&mut cw, count, &mut rng);
            assert_eq!(Tile::decode_codeword(&cw), Ok((tile, count)), "trial {trial}, {count} errors");
        }
    }

    #[test]
    fn beyond_capacity_is_rejected_never_wrong() {
        let mut rng = Rng(3);
        let mut rejected = 0;
        for trial in 0..3000 {
            let tile = sample_tile(&mut rng);
            let mut cw = tile.encode();
            corrupt(&mut cw, 11 + trial % 54, &mut rng);
            match Tile::decode_codeword(&cw) {
                Ok((t, _)) => assert_eq!(t, tile, "trial {trial}: wrong tile accepted"),
                Err(_) => rejected += 1,
            }
        }
        assert_eq!(rejected, 3000);
        // Pure garbage never panics and never passes the CRC.
        for _ in 0..3000 {
            let cw: Codeword = std::array::from_fn(|_| rng.next() as u8);
            assert!(Tile::decode_codeword(&cw).is_err());
        }
    }

    #[test]
    fn crc_catches_valid_rs_codeword_with_bad_data() {
        let tile = Tile::data(1, 2, 3, [9; CONTENT_BYTES]);
        let mut d = tile.to_bytes();
        d[50] ^= 1;
        let encoded = reed_solomon::Encoder::new(PARITY_BYTES).encode(&d);
        let cw: Codeword = encoded[..].try_into().unwrap();
        assert_eq!(Tile::decode_codeword(&cw), Err(TileError::BadCrc));
    }

    #[test]
    fn header_fields() {
        let tile = Tile::data(0xBEEF, 7, 0xABCDEF, [0x5A; CONTENT_BYTES]);
        let d = tile.to_bytes();
        assert_eq!(&d[..8], &[1, 0, 0xBE, 0xEF, 7, 0xAB, 0xCD, 0xEF]);
        assert_eq!(&d[104..], &crate::crc32c(&d[..104]).to_be_bytes());
        let meta = Tile::meta(0x1234, [0; CONTENT_BYTES]).to_bytes();
        assert_eq!(&meta[..8], &[2, 0, 0x12, 0x34, 0, 0, 0, 0]);
    }
}
