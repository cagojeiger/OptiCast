//! Golden bytes of the sender: the exact terminal text, META block and transfer
//! ID that today's sender produces for a few fixed inputs.
//!
//! The web receiver deploys on every merge, while released `diodecam` binaries
//! stay in the field for months. Every other multi-step test is a round trip
//! through one commit, so a change made symmetrically to both sides (layout,
//! whitening, tile header, META fields, symbol order, deflate output…) passes
//! them all. This one does not: a failure here means a released sender and this
//! receiver would disagree on what is on screen.
//!
//! Updating these constants is a protocol / sender change. Do it only on
//! purpose, together with the matching receiver change, and say so in the
//! release notes (old senders vs new receiver, and the other way round).

use diodecam_core::{ansi, crc32c, frame, Compression, Layout, Profile, SendOptions, Transfer};

/// Frames per case: enough for the source pass and repair symbols of the small files.
const FRAMES: usize = 12;
/// A fixed r₀; the real sender draws it at random.
const R0: u32 = 12_345;

/// splitmix64, so the inputs do not depend on any library.
fn bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut s = seed;
    (0..len)
        .map(|_| {
            s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            (z ^ (z >> 31)) as u8
        })
        .collect()
}

struct Case {
    data: Vec<u8>,
    name: &'static str,
    profile: Profile,
    cols: usize,
    rows: usize,
}

struct Golden {
    id: u32,
    meta: String,
    /// CRC-32C of the concatenated ANSI text of `FRAMES` frames.
    frames: u32,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// What `diodecam send` writes per frame (crates/diodecam-cli/src/frames.rs),
/// with fixed status lines: one shorter than the terminal (padded), one longer (cut).
fn run(case: &Case) -> (Transfer, Layout, Golden) {
    let mut tx = Transfer::prepare(&case.data, case.name, SendOptions::default(), R0).unwrap();
    let layout = Layout::for_terminal(case.profile, case.cols, case.rows).unwrap();
    let long = "+repair 1,234 · 15 fps · phone needs ~3s of view · ".repeat(6);
    let status = ["golden status line", long.as_str()];
    let mut text = String::new();
    for i in 0..FRAMES {
        let grid = frame::render(&layout, &tx.next_frame(&layout));
        text.push_str(&ansi::frame(&grid, case.profile, case.cols, case.rows, status, i == 0));
    }
    let golden = Golden { id: tx.id(), meta: hex(tx.meta_bytes()), frames: crc32c(text.as_bytes()) };
    (tx, layout, golden)
}

fn check(what: &str, got: &Golden, id: u32, meta: &str, frames: u32) {
    assert_eq!(
        (got.id, got.meta.as_str(), got.frames),
        (id, meta, frames),
        "{what}: the sender's bytes changed (see the top of tests/golden.rs); now id 0x{:08x}, meta \"{}\", frames 0x{:08x}",
        got.id,
        got.meta,
        got.frames,
    );
}

#[test]
fn ssh_120x40_with_repair_symbols() {
    let case = Case { data: bytes(2000, 1), name: "golden.bin", profile: Profile::Ssh, cols: 120, rows: 40 };
    let (tx, layout, got) = run(&case);
    assert_eq!((layout.width(), layout.height(), layout.tiles()), (119, 76, 7));
    assert_eq!(tx.meta().compression, Compression::None, "random bytes do not deflate");
    assert!(tx.source_progress() == 1.0 && tx.repair_sent() > 0, "the frames include repair symbols");
    let meta = concat!(
        "28bf8244",                                                                     // transfer ID
        "00000000000007d0",                                                             // size 2000
        "5bfc6931f59e154e57284bbb7b20a37d0253abb73ccae48630e3b48980cdab1a",             // SHA-256
        "00",                                                                           // no compression
        "00000007d000006001000108",                                                     // OTI
        "0a",                                                                           // name length
        "676f6c64656e2e62696e00000000000000000000000000000000000000000000000000000000", // "golden.bin"
    );
    check("ssh 120x40", &got, 0x28bf_8244, meta, 0xf78f_7e50);
}

#[test]
fn vt100_200x55_with_a_truncated_utf8_name() {
    let case = Case {
        data: bytes(3000, 2),
        name: "분기별-매출-보고서-최종본.pdf",
        profile: Profile::Vt100,
        cols: 200,
        rows: 55,
    };
    let (tx, layout, got) = run(&case);
    assert_eq!((layout.width(), layout.height()), (199, 53));
    assert_eq!(tx.meta().compression, Compression::None);
    assert!(tx.meta().filename.len() <= 38 && tx.meta().filename.ends_with(".pdf"));
    assert!(tx.repair_sent() > 0);
    let meta = concat!(
        "0ee006de",                                                                     // transfer ID
        "0000000000000bb8",                                                             // size 3000
        "df4e7eba4966d4a311476e55a6575630a2858b5f6ad21623164d9a94e332d07c",             // SHA-256
        "00",                                                                           // no compression
        "0000000bb800006001000108",                                                     // OTI
        "25",                                                                           // name length 37
        "ebb684eab8b0ebb3842deba7a4ecb69c2debb3b4eab3a0ec849c2decb59ceca2852e70646600", // "분기별-매출-보고서-최종.pdf"
    );
    check("vt100 200x55", &got, 0x0ee0_06de, meta, 0x97f1_515f);
}

/// Also pins the deflate (miniz_oxide) output, which decides the transfer ID of
/// every compressible file.
#[test]
fn compressible_file_is_deflated() {
    let text = b"DiodeCam golden text: the quick brown fox jumps over the lazy dog.\n".repeat(300);
    assert!(text.len() > 20_000);
    let case = Case { data: text, name: "notes.txt", profile: Profile::Ssh, cols: 120, rows: 40 };
    let (tx, _, got) = run(&case);
    assert_eq!(tx.meta().compression, Compression::DeflateRaw);
    assert!(tx.payload_len() < 1000);
    let meta = concat!(
        "2ee87541",                                                                     // transfer ID
        "0000000000004e84",                                                             // size 20100
        "3e81ecd7c281cc698a0f47acf574e44bb116afdba3fa905fa7ffbbd09a09e7a3",             // SHA-256
        "01",                                                                           // deflate-raw
        "000000009600006001000108",                                                     // OTI: 150-byte payload
        "09",                                                                           // name length
        "6e6f7465732e7478740000000000000000000000000000000000000000000000000000000000", // "notes.txt"
    );
    check("deflate", &got, 0x2ee8_7541, meta, 0x6528_57ff);
}

#[test]
fn empty_file_is_meta_only() {
    let case = Case { data: Vec::new(), name: "empty.txt", profile: Profile::Ssh, cols: 120, rows: 40 };
    let (tx, _, got) = run(&case);
    assert_eq!((tx.source_symbols(), tx.meta().oti), (0, [0; 12]));
    let meta = concat!(
        "9fa2a004",                                                                     // transfer ID
        "0000000000000000",                                                             // size 0
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",             // SHA-256 of nothing
        "00",                                                                           // no compression
        "000000000000000000000000",                                                     // OTI: all zero (F = 0)
        "09",                                                                           // name length
        "656d7074792e7478740000000000000000000000000000000000000000000000000000000000", // "empty.txt"
    );
    check("empty", &got, 0x9fa2_a004, meta, 0xf954_48e7);
}
