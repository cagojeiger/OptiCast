//! DiodeCam protocol core (`docs/protocol.md`). No I/O, clocks or threads,
//! so the same code builds for the CLI sender and a wasm32 receiver.
//!
//! Sender pipeline, once per frame:
//! [`sender::Transfer::next_frame`] → [`frame::render`] → [`ansi::frame`] → one write.
//!
//! Receiver pipeline:
//! 1. Get a module grid and its format information — from a camera sampler, or
//!    from terminal text with [`ansi::parse_screen`]. For a sampled grid,
//!    [`frame::read_format`] checks the FI (3-copy majority + CRC-8, two places).
//! 2. [`layout::Layout::from_format`] gives the data-module order
//!    ([`layout::Layout::tile_modules`]).
//! 3. [`frame::read_tiles`] → [`tile::decode`] per position (de-whiten → RS → CRC-32C → [`tile::Tile`]),
//!    or [`frame::decode_tiles`] for both steps.
//! 4. [`receiver::Assembler::accept`] each tile; when [`receiver::Assembler::is_complete`],
//!    [`receiver::Assembler::finalize`] returns the verified file.

#![forbid(unsafe_code)]

pub mod ansi;
pub mod frame;
pub mod layout;
pub mod meta;
pub mod receiver;
pub mod sender;
pub mod tile;

pub use frame::ModuleGrid;
pub use layout::{FormatInfo, Layout, Profile, TooSmall};
pub use meta::{Compression, Meta};
pub use receiver::{Accepted, Assembler, ReceiveError};
pub use sender::{SendOptions, Transfer};
pub use tile::{Tile, TileError, TileKind};

/// CRC-32C (Castagnoli), used for tiles and the transfer ID.
pub fn crc32c(bytes: &[u8]) -> u32 {
    const CASTAGNOLI: crc::Crc<u32> = crc::Crc::<u32>::new(&crc::CRC_32_ISCSI);
    CASTAGNOLI.checksum(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn crc32c_check_value() {
        assert_eq!(super::crc32c(b"123456789"), 0xE306_9283);
    }
}
