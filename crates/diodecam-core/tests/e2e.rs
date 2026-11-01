//! End to end through the real terminal encoding: file → sender frames → ANSI
//! bytes → `parse_screen` → module grid → tiles → receiver → file.

use std::collections::HashMap;

use diodecam_core::meta::Compression;
use diodecam_core::tile::{self, Tile, TileKind};
use diodecam_core::{ansi, frame, Assembler, Layout, Profile, SendOptions, Transfer};

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

    fn chance(&mut self, p: f64) -> bool {
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p
    }
}

fn random_bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng(seed);
    (0..len).map(|_| rng.next() as u8).collect()
}

/// Everything the sender put on screen, so a test can prove that every tile
/// the receiver accepted is exactly one that was sent.
struct Sent {
    tag: u16,
    meta: [u8; 96],
    symbols: HashMap<(u8, u32), [u8; 96]>,
}

impl Sent {
    fn record(&mut self, t: Tile) {
        if t.kind == TileKind::Data {
            self.symbols.insert((t.sbn, t.esi), t.content);
        }
    }

    fn check(&self, t: &Tile) {
        assert_eq!(t.tag, self.tag, "wrong tag accepted");
        match t.kind {
            TileKind::Meta => assert_eq!(t.content, self.meta, "wrong META accepted"),
            TileKind::Data => {
                assert_eq!(
                    self.symbols.get(&(t.sbn, t.esi)),
                    Some(&t.content),
                    "wrong symbol {}/{} accepted",
                    t.sbn,
                    t.esi
                )
            }
        }
    }
}

struct Scenario {
    profile: Profile,
    /// Terminal size for frame f.
    size: fn(u64) -> (usize, usize),
    /// Frames the phone never sees (late join).
    skip_frames: u64,
    /// Fraction of tiles lost after sampling.
    drop_rate: f64,
    /// Up to this many byte errors injected into each tile (module flips).
    max_byte_errors: usize,
    /// Every k-th frame is captured torn: top half of frame f+1 over frame f.
    tear_every: Option<u64>,
    compress: bool,
    max_frames: u64,
}

impl Default for Scenario {
    fn default() -> Self {
        Scenario {
            profile: Profile::Ssh,
            size: |_| (200, 55),
            skip_frames: 0,
            drop_rate: 0.0,
            max_byte_errors: 0,
            tear_every: None,
            compress: true,
            max_frames: 5000,
        }
    }
}

#[derive(Debug)]
struct Outcome {
    frames_seen: u64,
    accepted: u64,
    rejected: u64,
    torn: u64,
    compression: Compression,
    source_symbols: u64,
}

/// Cuts a frame string partway through the grid: just after the CUP of the
/// middle row plus a few cells, so one row of tiles is split mid-row.
fn first_half(text: &str, grid_rows: usize) -> &str {
    let cup = format!("\x1b[{};1H", grid_rows / 2 + 1);
    let start = text.find(&cup).expect("middle row") + cup.len();
    let cut = text[start..].char_indices().nth(53).map_or(text.len(), |(i, _)| start + i);
    &text[..cut]
}

fn run(data: &[u8], s: &Scenario) -> (Vec<u8>, Outcome) {
    let mut tx = Transfer::prepare(data, "file.bin", SendOptions { compress: s.compress }, 0x5_4321).unwrap();
    let mut sent = Sent { tag: tx.meta().tag(), meta: *tx.meta_bytes(), symbols: HashMap::new() };
    let mut rx = Assembler::new();
    let mut rng = Rng(0xC0FFEE);
    let mut out = Outcome {
        frames_seen: 0,
        accepted: 0,
        rejected: 0,
        torn: 0,
        compression: tx.meta().compression,
        source_symbols: tx.source_symbols(),
    };
    let mut previous: Option<(String, (usize, usize))> = None;
    let mut drawn_format = None;

    for f in 0..s.max_frames {
        let (cols, rows) = (s.size)(f);
        let layout = Layout::for_terminal(s.profile, cols, rows).unwrap();
        let codewords = tx.next_frame(&layout);
        for cw in &codewords {
            sent.record(Tile::decode_codeword(cw).unwrap().0);
        }
        let grid = frame::render(&layout, &codewords);
        let clear = drawn_format != Some(layout.format());
        drawn_format = Some(layout.format());
        let text = ansi::frame(&grid, s.profile, cols, rows, ["DiodeCam test", "status"], clear);

        if f < s.skip_frames {
            previous = Some((text, (cols, rows)));
            continue;
        }
        // What the camera captures: normally the whole frame; sometimes the new
        // frame only half drawn over the previous one.
        let torn = s.tear_every.is_some_and(|k| f % k == 0)
            && previous.as_ref().is_some_and(|(_, size)| *size == (cols, rows));
        let screen = match (&previous, torn) {
            (Some((prev, _)), true) => {
                out.torn += 1;
                format!("{prev}{}", first_half(&text, layout.height() / s.profile.modules_per_cell()))
            }
            _ => text.clone(),
        };
        previous = Some((text, (cols, rows)));

        let parsed = ansi::parse_screen(&screen, cols, rows).expect("format information found");
        assert_eq!(parsed.format, layout.format());
        out.frames_seen += 1;
        let layout = Layout::from_format(parsed.format).unwrap();
        let mut grid = parsed.grid;

        // Sampling errors: flip one module in each of up to `max_byte_errors` bytes per tile.
        if s.max_byte_errors > 0 {
            for n in 0..layout.tiles() {
                let modules = layout.tile_modules(n);
                let mut bytes: Vec<usize> = (0..128).collect();
                for i in 0..rng.below(s.max_byte_errors + 1) {
                    let j = i + rng.below(128 - i);
                    bytes.swap(i, j);
                    let m = modules[bytes[i] * 8 + rng.below(8)] as usize;
                    grid.set_index(m, !grid.get_index(m));
                }
            }
        }

        for (n, raw) in frame::read_tiles(&layout, &grid).iter().enumerate() {
            if rng.chance(s.drop_rate) {
                continue;
            }
            match tile::decode(raw, n) {
                Ok(t) => {
                    sent.check(&t);
                    rx.accept(&t);
                    out.accepted += 1;
                }
                Err(_) => out.rejected += 1,
            }
        }
        if rx.is_complete() {
            break;
        }
    }
    assert!(rx.is_complete(), "not complete: {out:?}, stats {:?}", rx.stats());
    (rx.finalize().expect("verified file"), out)
}

const FILE_BYTES: usize = 300_000;

#[test]
fn ssh_200x55() {
    let data = random_bytes(FILE_BYTES, 1);
    let (restored, out) = run(&data, &Scenario::default());
    assert_eq!(restored, data);
    assert_eq!(out.compression, Compression::None);
    assert_eq!(out.rejected, 0);
    // No loss: done within one source pass (18 DATA tiles per frame) plus a frame.
    assert!(out.frames_seen <= out.source_symbols.div_ceil(18) + 1, "{out:?}");
}

#[test]
fn resize_mid_stream() {
    let data = random_bytes(FILE_BYTES, 2);
    let scenario = Scenario { size: |f| if (f / 4) % 2 == 0 { (80, 24) } else { (200, 55) }, ..Scenario::default() };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert_eq!(out.rejected, 0);
}

#[test]
fn late_join_with_loss() {
    let data = random_bytes(FILE_BYTES, 3);
    // 120x40 has 7 tiles (6.5 DATA per frame): the source pass is over by frame 481.
    let scenario = Scenario { size: |_| (120, 40), skip_frames: 600, drop_rate: 0.2, ..Scenario::default() };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert!(out.accepted as f64 >= out.source_symbols as f64, "{out:?}");
}

#[test]
fn module_flips_are_corrected() {
    let data = random_bytes(FILE_BYTES, 4);
    let scenario = Scenario { max_byte_errors: 10, ..Scenario::default() };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert_eq!(out.rejected, 0, "RS must fix up to 10 byte errors: {out:?}");
}

#[test]
fn torn_frames_never_inject_wrong_data() {
    let data = random_bytes(FILE_BYTES, 5);
    let scenario = Scenario { tear_every: Some(3), ..Scenario::default() };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert!(out.torn > 10 && out.rejected > 0, "tears must actually cut tiles: {out:?}");
}

#[test]
fn torn_frames_with_errors_and_loss() {
    let data = random_bytes(FILE_BYTES, 6);
    let scenario = Scenario {
        size: |_| (120, 40),
        tear_every: Some(2),
        max_byte_errors: 6,
        drop_rate: 0.1,
        ..Scenario::default()
    };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert!(out.rejected > 0, "{out:?}");
}

#[test]
fn vt100_profile() {
    let data = random_bytes(FILE_BYTES, 7);
    let scenario = Scenario { profile: Profile::Vt100, ..Scenario::default() };
    let (restored, out) = run(&data, &scenario);
    assert_eq!(restored, data);
    assert_eq!(out.rejected, 0);
}

#[test]
fn empty_file() {
    let (restored, out) = run(&[], &Scenario::default());
    assert!(restored.is_empty());
    assert_eq!(out.frames_seen, 1);
    assert_eq!(out.source_symbols, 0);
}

#[test]
fn compressible_file_uses_deflate() {
    let mut data = Vec::new();
    for i in 0..30_000 {
        data.extend_from_slice(format!("line {i:05} status=ok\n").as_bytes());
    }
    let (restored, out) = run(&data, &Scenario { size: |_| (120, 40), ..Scenario::default() });
    assert_eq!(out.compression, Compression::DeflateRaw);
    assert!(out.source_symbols < (data.len() / 96 / 4) as u64, "{out:?}");
    assert_eq!(restored, data);
}

#[test]
fn restart_with_new_r0_merges_symbols() {
    // Same file, same settings: the second sender has the same transfer ID, so
    // symbols from both runs combine (spec §5).
    let data = random_bytes(50_000, 8);
    let layout = Layout::for_terminal(Profile::Ssh, 120, 40).unwrap();
    let mut a = Transfer::prepare(&data, "f", SendOptions::default(), 1).unwrap();
    let mut b = Transfer::prepare(&data, "f", SendOptions::default(), 777_777).unwrap();
    assert_eq!(a.id(), b.id());
    let mut rx = Assembler::new();
    let k = a.source_symbols();
    // Half of the source pass from the first run, then only repair symbols from the second.
    for _ in 0..(k / 2 / 7) {
        for t in a.next_frame_tiles(layout.tiles()) {
            rx.accept(&t);
        }
    }
    for _ in 0..(k / 6) {
        b.next_frame_tiles(layout.tiles()); // skip b's source pass
    }
    while !rx.is_complete() {
        for t in b.next_frame_tiles(layout.tiles()) {
            rx.accept(&t);
        }
    }
    assert_eq!(rx.finalize().unwrap(), data);
}
