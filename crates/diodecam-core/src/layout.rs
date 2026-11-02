//! Grid geometry (spec §1, §2): grid size per profile, the fixed pattern (quiet
//! border, finder marks, timing lines, format information) and the order of the
//! data modules that carry the tiles.
//!
//! Coordinates: origin top-left, `x` = column, `y` = row. A module value of
//! `true` (1) is the terminal's foreground color, `false` (0) its background.

use std::fmt;

/// Modules per tile: one 128-byte RS codeword, MSB first.
pub const TILE_MODULES: usize = 1024;
/// Narrowest grid: the format information (x ≤ 57) must clear the top-right finder.
pub const MIN_WIDTH: usize = 68;
/// Shortest grid: below this the top and bottom fixed regions overlap.
pub const MIN_HEIGHT: usize = 20;
/// Fewest tiles per frame.
pub const MIN_TILES: usize = 2;
/// Largest width or height the 9-bit FI fields can carry.
pub const MAX_SIDE: usize = 511;
/// Terminal rows reserved for the status bar (`docs/cli.md`).
pub const STATUS_ROWS: usize = 2;

/// How modules map to terminal cells (spec §1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Profile {
    /// One cell = two modules (top/bottom) drawn with `' '`, `'▀'` and reverse video.
    Ssh,
    /// One cell = one module drawn with `' '` and reverse video.
    Vt100,
}

impl Profile {
    /// The 2-bit profile code in the format information.
    pub const fn code(self) -> u32 {
        match self {
            Profile::Ssh => 0,
            Profile::Vt100 => 1,
        }
    }

    pub const fn from_code(code: u32) -> Option<Profile> {
        match code {
            0 => Some(Profile::Ssh),
            1 => Some(Profile::Vt100),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Profile::Ssh => "ssh",
            Profile::Vt100 => "vt100",
        }
    }

    /// Module rows per terminal row.
    pub const fn modules_per_cell(self) -> usize {
        match self {
            Profile::Ssh => 2,
            Profile::Vt100 => 1,
        }
    }

    /// Grid size W×H for a terminal of `cols` × `rows` cells (spec §1). The last
    /// column and the two status rows are never part of the grid.
    pub fn grid_size(self, cols: usize, rows: usize) -> (usize, usize) {
        let w = cols.saturating_sub(1).min(MAX_SIDE);
        let grid_rows = rows.saturating_sub(STATUS_ROWS);
        let h = match self {
            Profile::Ssh => (2 * grid_rows).min(510),
            Profile::Vt100 => grid_rows.min(MAX_SIDE),
        };
        (w, h)
    }
}

impl fmt::Display for Profile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Format information (spec §2.4): what a receiver needs to sample a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FormatInfo {
    pub profile: Profile,
    pub width: usize,
    pub height: usize,
}

/// Bits in the FI pattern: the 32-bit word repeated three times.
pub const FI_BITS: usize = 96;
const FI_VERSION: u32 = 2;
const FI_X0: usize = 10;
const FI_ROW_BITS: usize = 48;

impl FormatInfo {
    /// The 32-bit FI word: version, profile, W, H, reserved 0, CRC-8.
    pub fn word(&self) -> u32 {
        let head = (FI_VERSION << 29)
            | (self.profile.code() << 27)
            | ((self.width as u32 & 0x1FF) << 18)
            | ((self.height as u32 & 0x1FF) << 9);
        head | crc8(&head.to_be_bytes()[..3]) as u32
    }

    /// Parses a 32-bit FI word; `None` if the CRC, version, profile or reserved bit is wrong.
    pub fn from_word(word: u32) -> Option<FormatInfo> {
        if crc8(&word.to_be_bytes()[..3]) as u32 != word & 0xFF {
            return None;
        }
        if word >> 29 != FI_VERSION || word & 0x100 != 0 {
            return None;
        }
        Some(FormatInfo {
            profile: Profile::from_code((word >> 27) & 0x3)?,
            width: ((word >> 18) & 0x1FF) as usize,
            height: ((word >> 9) & 0x1FF) as usize,
        })
    }

    /// The 96-bit FI pattern; bit 0 is the MSB of the first copy.
    pub fn bits(&self) -> [bool; FI_BITS] {
        let word = self.word();
        std::array::from_fn(|i| (word >> (31 - i % 32)) & 1 == 1)
    }

    /// Recovers FI from a sampled 96-bit pattern: bitwise majority over the three
    /// copies, then the CRC check.
    pub fn from_bits(bits: &[bool; FI_BITS]) -> Option<FormatInfo> {
        let mut word = 0u32;
        for i in 0..32 {
            let votes = bits[i] as u8 + bits[i + 32] as u8 + bits[i + 64] as u8;
            word = (word << 1) | (votes >= 2) as u32;
        }
        FormatInfo::from_word(word)
    }
}

/// Position of FI bit `i` (0..96) in the top copy (rows 2–3).
pub fn fi_top_position(i: usize) -> (usize, usize) {
    (FI_X0 + i % FI_ROW_BITS, 2 + i / FI_ROW_BITS)
}

/// Position of FI bit `i` (0..96) in the bottom copy (rows H−4 and H−3).
pub fn fi_bottom_position(i: usize, height: usize) -> (usize, usize) {
    (FI_X0 + i % FI_ROW_BITS, height - 4 + i / FI_ROW_BITS)
}

/// CRC-8, polynomial 0x07, initial value 0, no reflection (CRC-8/SMBUS).
pub fn crc8(bytes: &[u8]) -> u8 {
    const CRC8: crc::Crc<u8> = crc::Crc::<u8>::new(&crc::CRC_8_SMBUS);
    CRC8.checksum(bytes)
}

/// The grid cannot hold a frame (spec §2.5): the sender shows a message instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TooSmall {
    pub width: usize,
    pub height: usize,
    /// Tiles that would fit (0 when the fixed regions do not fit at all).
    pub tiles: usize,
}

impl fmt::Display for TooSmall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "grid {}x{} holds {} tiles; need width >= {MIN_WIDTH}, height >= {MIN_HEIGHT} and >= {MIN_TILES} tiles",
            self.width, self.height, self.tiles
        )
    }
}

impl std::error::Error for TooSmall {}

/// Marker in [`Layout`]'s fixed pattern for a data module.
const DATA: u8 = 2;

/// A frame layout: the fixed pattern and the data-module order for one W×H grid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    format: FormatInfo,
    tiles: usize,
    /// Per module (index y·W + x): 0 or 1 for reserved modules, `DATA` otherwise.
    pattern: Vec<u8>,
    /// Indices (y·W + x) of the data modules in row-major order.
    data: Vec<u32>,
}

impl Layout {
    /// Layout for a W×H grid. Fails if the grid is below the minimum size.
    pub fn new(profile: Profile, width: usize, height: usize) -> Result<Layout, TooSmall> {
        Layout::from_format(FormatInfo { profile, width, height })
    }

    /// Layout for a terminal of `cols` × `rows` cells (spec §1).
    pub fn for_terminal(profile: Profile, cols: usize, rows: usize) -> Result<Layout, TooSmall> {
        let (w, h) = profile.grid_size(cols, rows);
        Layout::new(profile, w, h)
    }

    /// Layout described by a decoded format information word (receiver side).
    pub fn from_format(format: FormatInfo) -> Result<Layout, TooSmall> {
        let FormatInfo { width: w, height: h, .. } = format;
        let too_small = |tiles| TooSmall { width: w, height: h, tiles };
        if w < MIN_WIDTH || h < MIN_HEIGHT || w > MAX_SIDE || h > MAX_SIDE {
            return Err(too_small(0));
        }
        let pattern = fixed_pattern(format);
        let data: Vec<u32> = (0..pattern.len() as u32).filter(|&i| pattern[i as usize] == DATA).collect();
        let tiles = data.len() / TILE_MODULES;
        if tiles < MIN_TILES {
            return Err(too_small(tiles));
        }
        Ok(Layout { format, tiles, pattern, data })
    }

    pub fn format(&self) -> FormatInfo {
        self.format
    }

    pub fn profile(&self) -> Profile {
        self.format.profile
    }

    pub fn width(&self) -> usize {
        self.format.width
    }

    pub fn height(&self) -> usize {
        self.format.height
    }

    /// Tiles per frame, N = ⌊D / 1024⌋.
    pub fn tiles(&self) -> usize {
        self.tiles
    }

    /// All data modules (D of them) as indices y·W + x, in row-major order.
    pub fn data_modules(&self) -> &[u32] {
        &self.data
    }

    /// The 1024 data modules of tile `n`; module `8k + j` carries bit `7 − j` of byte `k`.
    pub fn tile_modules(&self, n: usize) -> &[u32] {
        &self.data[n * TILE_MODULES..(n + 1) * TILE_MODULES]
    }

    /// The D − 1024·N leftover data modules, filled with the whitening stream for n = N.
    pub fn filler_modules(&self) -> &[u32] {
        &self.data[self.tiles * TILE_MODULES..]
    }

    /// The fixed value of a reserved module, or `None` for a data module.
    pub fn fixed(&self, x: usize, y: usize) -> Option<bool> {
        match self.pattern[y * self.format.width + x] {
            DATA => None,
            v => Some(v == 1),
        }
    }
}

/// Smallest terminal height (rows) at which `cols` columns give a valid layout.
pub fn min_rows(profile: Profile, cols: usize) -> Option<usize> {
    if profile.grid_size(cols, 0).0 < MIN_WIDTH {
        return None;
    }
    (STATUS_ROWS + 1..=STATUS_ROWS + MAX_SIDE).find(|&rows| Layout::for_terminal(profile, cols, rows).is_ok())
}

/// Builds the fixed pattern of spec §2.1–2.4. Requires W ≥ 68 and H ≥ 20 so that
/// no two regions overlap.
fn fixed_pattern(format: FormatInfo) -> Vec<u8> {
    let FormatInfo { width: w, height: h, .. } = format;
    let mut p = vec![DATA; w * h];
    let mut set = |x: usize, y: usize, v: bool| p[y * w + x] = v as u8;

    // §2.1 quiet border.
    for x in 0..w {
        set(x, 0, false);
        set(x, h - 1, false);
    }
    for y in 0..h {
        set(0, y, false);
        set(w - 1, y, false);
    }

    // §2.2 finder marks, each wrapped in a 1-module separator of zeros.
    for (x0, y0, size) in [(2, 2, 7), (w - 9, 2, 7), (2, h - 9, 7), (w - 7, h - 7, 5)] {
        let c = (size / 2) as isize;
        for j in -1..=size as isize {
            for i in -1..=size as isize {
                let inside = (0..size as isize).contains(&i) && (0..size as isize).contains(&j);
                let d = (i - c).abs().max((j - c).abs());
                // Outer ring dark, next ring light, centre dark.
                let v = inside && d != c - 1;
                set((x0 as isize + i) as usize, (y0 as isize + j) as usize, v);
            }
        }
    }

    // §2.3 timing lines: alternate, starting with 1.
    for x in 10..=w - 11 {
        set(x, 5, (x - 10) % 2 == 0);
    }
    for x in 10..=w - 9 {
        set(x, h - 6, (x - 10) % 2 == 0);
    }
    for y in 10..=h.saturating_sub(11) {
        set(5, y, (y - 10) % 2 == 0);
    }
    for y in 10..=h - 9 {
        set(w - 6, y, (y - 10) % 2 == 0);
    }

    // §2.4 format information, top and bottom copies.
    let bits = format.bits();
    for (i, &bit) in bits.iter().enumerate() {
        let (x, y) = fi_top_position(i);
        set(x, y, bit);
        let (x, y) = fi_bottom_position(i, h);
        set(x, y, bit);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Independent reading of the spec tables: is (x, y) reserved?
    fn spec_reserved(w: usize, h: usize, x: usize, y: usize) -> bool {
        let r = |x0: usize, x1: usize, y0: usize, y1: usize| (x0..=x1).contains(&x) && (y0..=y1).contains(&y);
        x == 0
            || y == 0
            || x == w - 1
            || y == h - 1
            || r(1, 9, 1, 9)
            || r(w - 10, w - 2, 1, 9)
            || r(1, 9, h - 10, h - 2)
            || r(w - 8, w - 2, h - 8, h - 2)
            || r(10, w - 11, 5, 5)
            || r(10, w - 9, h - 6, h - 6)
            || r(5, 5, 10, h - 11)
            || r(w - 6, w - 6, 10, h - 9)
            || r(10, 57, 2, 3)
            || r(10, 57, h - 4, h - 3)
    }

    fn expected_data(w: usize, h: usize) -> usize {
        let border = 2 * w + 2 * (h - 2);
        let finders = 3 * 81 + 49;
        let timing = (w - 20) + (w - 18) + (h - 20) + (h - 18);
        w * h - border - finders - timing - 2 * FI_BITS
    }

    #[test]
    fn fi_word_round_trip() {
        for profile in [Profile::Ssh, Profile::Vt100] {
            for (w, h) in [(68, 20), (79, 44), (199, 106), (511, 510), (511, 511), (0, 0)] {
                let fi = FormatInfo { profile, width: w, height: h };
                assert_eq!(FormatInfo::from_word(fi.word()), Some(fi));
                assert_eq!(FormatInfo::from_bits(&fi.bits()), Some(fi));
            }
        }
    }

    #[test]
    fn fi_word_layout_matches_spec() {
        let fi = FormatInfo { profile: Profile::Vt100, width: 199, height: 53 };
        let word = fi.word();
        assert_eq!(word >> 29, 2);
        assert_eq!((word >> 27) & 3, 1);
        assert_eq!((word >> 18) & 0x1FF, 199);
        assert_eq!((word >> 9) & 0x1FF, 53);
        assert_eq!(word & 0x100, 0);
        // CRC-8/SMBUS check value.
        assert_eq!(crc8(b"123456789"), 0xF4);
        assert_eq!(word & 0xFF, crc8(&word.to_be_bytes()[..3]) as u32);
    }

    #[test]
    fn fi_majority_and_crc() {
        let fi = FormatInfo { profile: Profile::Ssh, width: 199, height: 106 };
        // One copy completely wrong: the majority still recovers it.
        let mut bits = fi.bits();
        for b in &mut bits[32..64] {
            *b = !*b;
        }
        assert_eq!(FormatInfo::from_bits(&bits), Some(fi));
        // A single flipped word bit is caught by the CRC.
        for bit in 0..32 {
            assert_eq!(FormatInfo::from_word(fi.word() ^ (1 << bit)), None, "bit {bit}");
        }
        // Two copies flipped at the same bit beat the majority, and the CRC rejects it.
        let mut bits = fi.bits();
        bits[5] = !bits[5];
        bits[37] = !bits[37];
        assert_eq!(FormatInfo::from_bits(&bits), None);
    }

    #[test]
    fn reserved_regions_match_spec() {
        for profile in [Profile::Ssh, Profile::Vt100] {
            for (w, h) in [(68, 40), (68, 20), (79, 44), (119, 76), (199, 106), (199, 53), (511, 510)] {
                let Ok(layout) = Layout::new(profile, w, h) else { continue };
                for y in 0..h {
                    for x in 0..w {
                        assert_eq!(layout.fixed(x, y).is_some(), spec_reserved(w, h, x, y), "{w}x{h} at ({x},{y})");
                    }
                }
                assert_eq!(layout.data_modules().len(), expected_data(w, h), "{w}x{h}");
                // Row-major order.
                assert!(layout.data_modules().windows(2).all(|p| p[0] < p[1]));
            }
        }
    }

    #[test]
    fn fixed_values_match_spec() {
        let (w, h) = (199, 106);
        let layout = Layout::new(Profile::Ssh, w, h).unwrap();
        let v = |x, y| layout.fixed(x, y).unwrap();
        // Big finder at (2,2): ring, gap, 3×3 centre; separator around it.
        let big = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
        for (x0, y0) in [(2, 2), (w - 9, 2), (2, h - 9)] {
            for (j, row) in big.iter().enumerate() {
                for (i, c) in row.chars().enumerate() {
                    assert_eq!(v(x0 + i, y0 + j), c == '1', "finder at ({x0},{y0}) +({i},{j})");
                }
            }
            for k in 0..9 {
                for (x, y) in [(x0 - 1 + k, y0 - 1), (x0 - 1 + k, y0 + 7), (x0 - 1, y0 - 1 + k), (x0 + 7, y0 - 1 + k)] {
                    assert!(!v(x, y));
                }
            }
        }
        let small = ["11111", "10001", "10101", "10001", "11111"];
        for (j, row) in small.iter().enumerate() {
            for (i, c) in row.chars().enumerate() {
                assert_eq!(v(w - 7 + i, h - 7 + j), c == '1');
            }
        }
        // Timing lines start with 1 and alternate.
        assert!(v(10, 5) && !v(11, 5) && v(12, 5));
        assert!(v(10, h - 6) && !v(11, h - 6));
        assert!(v(5, 10) && !v(5, 11));
        assert!(v(w - 6, 10) && !v(w - 6, 11));
        assert_eq!(v(w - 11, 5), (w - 11 - 10) % 2 == 0);
        // FI copies.
        let bits = layout.format().bits();
        for (i, &bit) in bits.iter().enumerate() {
            let (x, y) = fi_top_position(i);
            assert_eq!(v(x, y), bit);
            let (x, y) = fi_bottom_position(i, h);
            assert_eq!(v(x, y), bit);
        }
        assert_eq!(fi_top_position(47), (57, 2));
        assert_eq!(fi_top_position(48), (10, 3));
        assert_eq!(fi_bottom_position(95, h), (57, h - 3));
    }

    #[test]
    fn tile_counts() {
        let tiles = |p, c, r| Layout::for_terminal(p, c, r).map(|l| (l.width(), l.height(), l.tiles()));
        assert_eq!(tiles(Profile::Ssh, 80, 24), Ok((79, 44, 2)));
        assert_eq!(tiles(Profile::Ssh, 120, 40), Ok((119, 76, 7)));
        assert_eq!(tiles(Profile::Ssh, 200, 55), Ok((199, 106, 19)));
        assert_eq!(tiles(Profile::Vt100, 200, 55), Ok((199, 53, 8)));
        let big = Layout::for_terminal(Profile::Ssh, 1000, 1000).unwrap();
        assert_eq!((big.width(), big.height()), (511, 510));
        assert_eq!(big.tiles(), expected_data(511, 510) / TILE_MODULES);
        assert_eq!(Layout::for_terminal(Profile::Vt100, 1000, 1000).unwrap().height(), 511);
    }

    #[test]
    fn too_small() {
        // W = 67 fails regardless of height.
        assert!(Layout::for_terminal(Profile::Ssh, 68, 200).is_err());
        assert!(Layout::for_terminal(Profile::Ssh, 69, 40).is_ok());
        // W ≥ 68 but fewer than two tiles.
        let err = Layout::for_terminal(Profile::Vt100, 80, 24).unwrap_err();
        assert_eq!((err.width, err.height, err.tiles), (79, 22, 0));
        // Plenty of tiles but too short: the fixed regions would overlap.
        assert!(Layout::for_terminal(Profile::Vt100, 512, 21).is_err());
        assert!(Layout::for_terminal(Profile::Vt100, 512, 22).is_ok());
        assert!(Layout::for_terminal(Profile::Ssh, 512, 11).is_err());
        assert!(Layout::for_terminal(Profile::Ssh, 512, 12).is_ok());
        assert!(Layout::for_terminal(Profile::Ssh, 0, 0).is_err());
        // min_rows agrees with for_terminal.
        for profile in [Profile::Ssh, Profile::Vt100] {
            for cols in [69, 80, 120, 200, 600] {
                let r = min_rows(profile, cols).unwrap();
                assert!(Layout::for_terminal(profile, cols, r).is_ok());
                assert!(Layout::for_terminal(profile, cols, r - 1).is_err());
            }
            assert_eq!(min_rows(profile, 68), None);
        }
    }

    #[test]
    fn tile_and_filler_modules_partition_data() {
        let layout = Layout::for_terminal(Profile::Ssh, 200, 55).unwrap();
        let n = layout.tiles();
        let total: usize = (0..n).map(|i| layout.tile_modules(i).len()).sum::<usize>() + layout.filler_modules().len();
        assert_eq!(total, layout.data_modules().len());
        assert_eq!(layout.filler_modules().len(), layout.data_modules().len() - 1024 * n);
    }
}
