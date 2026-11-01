//! Module grids (spec §2, §3): tiles → grid with the fixed pattern and filler,
//! and grid → raw tile bytes and format information for the receiver.

use crate::layout::{fi_bottom_position, fi_top_position, FormatInfo, Layout, FI_BITS, MIN_HEIGHT};
use crate::tile::{self, whiten, whitening, Codeword, Tile, TileError, CODEWORD_BYTES};

/// A W×H grid of modules; `true` = foreground (1), `false` = background (0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleGrid {
    width: usize,
    height: usize,
    bits: Vec<bool>,
}

impl ModuleGrid {
    /// An all-zero grid.
    pub fn new(width: usize, height: usize) -> ModuleGrid {
        ModuleGrid { width, height, bits: vec![false; width * height] }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn get(&self, x: usize, y: usize) -> bool {
        self.bits[y * self.width + x]
    }

    pub fn set(&mut self, x: usize, y: usize, v: bool) {
        self.bits[y * self.width + x] = v;
    }

    /// Module by index y·W + x, as used by [`Layout::data_modules`].
    pub fn get_index(&self, i: usize) -> bool {
        self.bits[i]
    }

    pub fn set_index(&mut self, i: usize, v: bool) {
        self.bits[i] = v;
    }
}

/// Draws one frame: the layout's fixed pattern, tile `n` (whitened for
/// position `n`) in its 1024 data modules, and the n = N whitening stream in
/// the leftover modules. `codewords` come from `Transfer::next_frame` and must
/// number exactly `layout.tiles()`.
pub fn render(layout: &Layout, codewords: &[Codeword]) -> ModuleGrid {
    assert_eq!(codewords.len(), layout.tiles(), "one codeword per tile position");
    let mut grid = ModuleGrid::new(layout.width(), layout.height());
    for y in 0..layout.height() {
        for x in 0..layout.width() {
            if let Some(v) = layout.fixed(x, y) {
                grid.set(x, y, v);
            }
        }
    }
    for (n, cw) in codewords.iter().enumerate() {
        let mut raw = *cw;
        whiten(&mut raw, n);
        put_bytes(&mut grid, layout.tile_modules(n), raw.iter().copied());
    }
    put_bytes(&mut grid, layout.filler_modules(), whitening(layout.tiles()));
    grid
}

/// Writes bytes MSB-first into the given modules.
fn put_bytes(grid: &mut ModuleGrid, modules: &[u32], bytes: impl Iterator<Item = u8>) {
    for (chunk, byte) in modules.chunks(8).zip(bytes) {
        for (j, &m) in chunk.iter().enumerate() {
            grid.set_index(m as usize, (byte >> (7 - j)) & 1 == 1);
        }
    }
}

/// Receiver: the raw (still whitened) bytes of every tile position, in order.
/// Decode each with [`tile::decode`]`(raw, n)`.
pub fn read_tiles(layout: &Layout, grid: &ModuleGrid) -> Vec<Codeword> {
    assert_eq!((grid.width(), grid.height()), (layout.width(), layout.height()));
    (0..layout.tiles())
        .map(|n| {
            let mut raw = [0u8; CODEWORD_BYTES];
            for (byte, chunk) in raw.iter_mut().zip(layout.tile_modules(n).chunks(8)) {
                *byte = chunk.iter().fold(0, |acc, &m| (acc << 1) | grid.get_index(m as usize) as u8);
            }
            raw
        })
        .collect()
}

/// Receiver: reads and decodes every tile of a frame.
pub fn decode_tiles(layout: &Layout, grid: &ModuleGrid) -> Vec<Result<Tile, TileError>> {
    read_tiles(layout, grid).iter().enumerate().map(|(n, raw)| tile::decode(raw, n)).collect()
}

/// Reads the top FI copy only (rows 2–3); it does not depend on H.
pub fn read_format_top(grid: &ModuleGrid) -> Option<FormatInfo> {
    read_copy(grid, fi_top_position)
}

/// Reads the bottom FI copy at rows H−4 and H−3 of this grid.
pub fn read_format_bottom(grid: &ModuleGrid) -> Option<FormatInfo> {
    let h = grid.height();
    read_copy(grid, |i| fi_bottom_position(i, h))
}

/// Format information of a grid sampled at its true size: either copy may be
/// damaged, but if both decode they must agree (a torn frame across a layout
/// change is rejected), and the result must match the grid's W×H.
pub fn read_format(grid: &ModuleGrid) -> Option<FormatInfo> {
    let fi = match (read_format_top(grid), read_format_bottom(grid)) {
        (Some(a), Some(b)) if a != b => return None,
        (Some(a), _) | (None, Some(a)) => a,
        (None, None) => return None,
    };
    (fi.width == grid.width() && fi.height == grid.height()).then_some(fi)
}

fn read_copy(grid: &ModuleGrid, position: impl Fn(usize) -> (usize, usize)) -> Option<FormatInfo> {
    // FI spans x ∈ [10, 57]; any grid that holds a layout is at least this big.
    if grid.width() < 58 || grid.height() < MIN_HEIGHT {
        return None;
    }
    let bits: [bool; FI_BITS] = std::array::from_fn(|i| {
        let (x, y) = position(i);
        grid.get(x, y)
    });
    FormatInfo::from_bits(&bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Profile;

    fn tiles(n: usize) -> Vec<Tile> {
        (0..n).map(|i| Tile::data(0x1234, 0, i as u32, [i as u8; 96])).collect()
    }

    #[test]
    fn render_then_read_round_trip() {
        for (cols, rows) in [(80, 24), (120, 40), (200, 55)] {
            let layout = Layout::for_terminal(Profile::Ssh, cols, rows).unwrap();
            let tiles = tiles(layout.tiles());
            let cws: Vec<Codeword> = tiles.iter().map(Tile::encode).collect();
            let grid = render(&layout, &cws);
            assert_eq!(read_format(&grid), Some(layout.format()));
            let decoded: Vec<Tile> = decode_tiles(&layout, &grid).into_iter().map(Result::unwrap).collect();
            assert_eq!(decoded, tiles);
            // Fixed modules come from the layout.
            for y in 0..layout.height() {
                for x in 0..layout.width() {
                    if let Some(v) = layout.fixed(x, y) {
                        assert_eq!(grid.get(x, y), v);
                    }
                }
            }
        }
    }

    #[test]
    fn filler_is_whitening_of_n() {
        let layout = Layout::for_terminal(Profile::Ssh, 200, 55).unwrap();
        let cws: Vec<Codeword> = tiles(layout.tiles()).iter().map(Tile::encode).collect();
        let grid = render(&layout, &cws);
        let filler = layout.filler_modules();
        let expected: Vec<bool> = whitening(layout.tiles())
            .flat_map(|b| (0..8).map(move |j| (b >> (7 - j)) & 1 == 1))
            .take(filler.len())
            .collect();
        let got: Vec<bool> = filler.iter().map(|&m| grid.get_index(m as usize)).collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn format_copies() {
        let layout = Layout::for_terminal(Profile::Ssh, 120, 40).unwrap();
        let cws: Vec<Codeword> = tiles(layout.tiles()).iter().map(Tile::encode).collect();
        let mut grid = render(&layout, &cws);
        // Destroy the top copy: the bottom one still identifies the frame.
        for i in 0..FI_BITS {
            let (x, y) = fi_top_position(i);
            grid.set(x, y, i % 3 == 0);
        }
        assert_eq!(read_format_top(&grid), None);
        assert_eq!(read_format(&grid), Some(layout.format()));
        // A wrong-size grid is rejected even though the top copy decodes.
        let other = Layout::for_terminal(Profile::Ssh, 120, 41).unwrap();
        let mut mixed = render(&other, &tiles(other.tiles()).iter().map(Tile::encode).collect::<Vec<_>>());
        assert!(read_format(&mixed).is_some());
        let fi = layout.format().bits();
        for (i, &bit) in fi.iter().enumerate() {
            let (x, y) = fi_top_position(i);
            mixed.set(x, y, bit);
        }
        assert_eq!(read_format(&mixed), None, "top and bottom disagree");
    }
}
