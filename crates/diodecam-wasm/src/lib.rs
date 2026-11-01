//! DiodeCam v2 receiver for the browser: `diodecam-vision` + `diodecam-core`'s
//! [`Assembler`] behind a plain C ABI (no wasm-bindgen). Build with
//! `cargo build --release --target wasm32-unknown-unknown -p diodecam-wasm`.
//!
//! Calling convention (all integers are 32-bit on wasm32):
//! - `alloc(len) -> ptr` / `dealloc(ptr, len)`: buffers the host writes into.
//! - `receiver_new() -> handle` (0 = failure), `receiver_free(handle)`, `receiver_reset(handle)`.
//! - `receiver_process(handle, ptr, len, width, height) -> i32`: one RGBA frame;
//!   returns the tiles that passed in this frame, or −1 when no grid was found
//!   (−2 for bad arguments).
//! - `receiver_stats(handle) -> ptr`: UTF-8 JSON; its length is `last_len()`.
//! - `receiver_file(handle) -> ptr`: the verified file (null until done); length `last_len()`.
//! - `receiver_export(handle) -> ptr` / `receiver_import(handle, ptr, len) -> i32`:
//!   collected tiles, to resume a transfer after a reload (IndexedDB).
//! - `receiver_set_debug(handle, on)`: adds per-tile positions to the stats.
//! - `receiver_set_limit(handle, mib)`: largest file accepted (default 64 MiB,
//!   clamped to 1–1024 MiB); a bigger transfer's META is refused before anything
//!   is allocated for it.
//!
//! Pointers returned by `receiver_stats`/`receiver_file`/`receiver_export` stay
//! valid until the next call on that handle; on failure they are null and
//! `last_len()` is 0. Nothing here does I/O: the frame
//! comes in, numbers and the file go out.
//!
//! `unsafe` is confined to the boundary: turning host pointers into slices
//! (`alloc`/`dealloc`/`receiver_process`/`receiver_import`). Each is documented.

#![deny(unsafe_op_in_unsafe_fn)]

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::fmt::Write as _;

use diodecam_core::receiver::DEFAULT_MAX_FILE;
use diodecam_core::tile::{self, Tile, TileKind, DATA_BYTES};
use diodecam_core::{frame, Accepted, Assembler, Layout};
use diodecam_vision::{luma_rgba, Detection, Point, Polarity, Vision};

/// Tiles kept for export at most (~32 MB); beyond that resume is not offered.
const MAX_KEPT: usize = 300_000;
/// Bounds for `receiver_set_limit`, in MiB.
pub const LIMIT_MIB: std::ops::RangeInclusive<u32> = 1..=1024;
const EXPORT_MAGIC: &[u8; 4] = b"OCS1";

/// One receiving session: a camera stream and the transfer it is collecting.
pub struct Receiver {
    vision: Vision,
    assembler: Assembler,
    gray: Vec<u8>,
    /// Buffer behind the last pointer handed out.
    out: Vec<u8>,
    file: Option<Vec<u8>>,
    error: Option<String>,
    debug: bool,
    /// Largest file accepted, in bytes (survives `reset`).
    limit: u64,
    /// META (once) plus every DATA tile given to the assembler, for export.
    kept: Vec<Tile>,
    kept_ids: HashSet<(u16, u8, u32)>,
    kept_meta: bool,
    frame: FrameStats,
    totals: Totals,
    /// Mean module position of each tile, for the debug overlay (per layout).
    centers: Option<(Layout, Vec<(f64, f64)>)>,
}

#[derive(Default)]
struct FrameStats {
    detection: Option<Detection>,
    tiles_ok: usize,
    tiles: usize,
    /// One char per tile position: '1' passed, '0' failed.
    status: String,
}

#[derive(Default)]
struct Totals {
    frames: u64,
    detections: u64,
    tiles_ok: u64,
    tiles: u64,
}

impl Default for Receiver {
    fn default() -> Self {
        Receiver::new()
    }
}

impl Receiver {
    pub fn new() -> Receiver {
        Receiver {
            vision: Vision::new(),
            assembler: Assembler::new(),
            gray: Vec::new(),
            out: Vec::new(),
            file: None,
            error: None,
            debug: false,
            limit: DEFAULT_MAX_FILE,
            kept: Vec::new(),
            kept_ids: HashSet::new(),
            kept_meta: false,
            frame: FrameStats::default(),
            totals: Totals::default(),
            centers: None,
        }
    }

    /// Processes one RGBA frame; returns the tiles that passed, −1 with no grid,
    /// −2 if the buffer does not hold `width`×`height` pixels.
    pub fn process_rgba(&mut self, rgba: &[u8], width: usize, height: usize) -> i32 {
        let Some(len) = width.checked_mul(height).and_then(|n| n.checked_mul(4)) else { return -2 };
        if width == 0 || height == 0 || rgba.len() < len {
            return -2;
        }
        let mut gray = std::mem::take(&mut self.gray);
        luma_rgba(&rgba[..len], &mut gray);
        let r = self.process_gray(&gray, width, height);
        self.gray = gray;
        r
    }

    /// Processes one grayscale frame.
    pub fn process_gray(&mut self, gray: &[u8], width: usize, height: usize) -> i32 {
        self.totals.frames += 1;
        self.frame = FrameStats::default();
        if width.checked_mul(height).is_none_or(|n| gray.len() < n) {
            return -2;
        }
        let Some(det) = self.vision.process(gray, width, height) else { return -1 };
        self.totals.detections += 1;
        let Ok(layout) = Layout::from_format(det.format) else { return -1 };
        let mut ok = 0;
        let mut status = String::with_capacity(layout.tiles());
        for (n, raw) in frame::read_tiles(&layout, &det.grid).iter().enumerate() {
            match tile::decode(raw, n) {
                Ok(t) => {
                    ok += 1;
                    status.push('1');
                    self.accept(t);
                }
                Err(_) => status.push('0'),
            }
        }
        if self.debug && self.centers.as_ref().is_none_or(|(l, _)| *l != layout) {
            self.centers = Some((layout.clone(), tile_centers(&layout)));
        }
        self.totals.tiles_ok += ok as u64;
        self.totals.tiles += layout.tiles() as u64;
        self.frame = FrameStats { detection: Some(det), tiles_ok: ok, tiles: layout.tiles(), status };
        self.finish();
        ok as i32
    }

    fn accept(&mut self, t: Tile) {
        if self.file.is_some() {
            return;
        }
        let result = self.assembler.accept(&t);
        let keep = match t.kind {
            // Also when the replay of held DATA completes the decode right away.
            TileKind::Meta => matches!(result, Accepted::MetaConfirmed | Accepted::Complete) && !self.kept_meta,
            TileKind::Data => {
                matches!(result, Accepted::Symbol | Accepted::Complete | Accepted::Pending)
                    && self.kept_ids.insert((t.tag, t.sbn, t.esi))
            }
        };
        if keep && self.kept.len() < MAX_KEPT {
            self.kept_meta |= t.kind == TileKind::Meta;
            self.kept.push(t);
        }
    }

    /// Verifies and keeps the file once RaptorQ has it. A failed verification
    /// restarts the decode inside the assembler; the collected tiles go with it.
    fn finish(&mut self) {
        if self.file.is_some() || !self.assembler.is_complete() {
            return;
        }
        match self.assembler.finalize() {
            Ok(data) => {
                self.file = Some(data);
                self.error = None;
                self.kept = Vec::new();
                self.kept_ids = HashSet::new();
                self.kept_meta = false;
            }
            Err(e) => {
                self.error = Some(e.to_string());
                if e.restarts() {
                    // The symbols went with the decode. META stays if it is still confirmed
                    // (an empty file's self-contradictory META is dropped for good).
                    let meta = self.assembler.meta().is_some();
                    self.kept.retain(|t| meta && t.kind == TileKind::Meta);
                    self.kept_meta = !self.kept.is_empty();
                    self.kept_ids.clear();
                }
                // Out of memory or over the limit: the payload is kept; try again later.
            }
        }
    }

    pub fn reset(&mut self) {
        let (debug, limit) = (self.debug, self.limit);
        *self = Receiver::new();
        self.debug = debug;
        self.set_limit(limit);
    }

    /// Largest file accepted, in bytes.
    pub fn set_limit(&mut self, bytes: u64) {
        self.limit = bytes;
        self.assembler.set_limit(bytes);
    }

    pub fn file(&self) -> Option<&[u8]> {
        self.file.as_deref()
    }

    /// Collected tiles: "OCS1", u32 count (BE), then 108 bytes per tile.
    pub fn export(&self) -> Vec<u8> {
        let tag = self.assembler.transfer_id().map(|id| id as u16);
        let tiles: Vec<&Tile> = self.kept.iter().filter(|t| tag.is_none_or(|g| t.tag == g)).collect();
        let mut out = Vec::with_capacity(8 + tiles.len() * DATA_BYTES);
        out.extend_from_slice(EXPORT_MAGIC);
        out.extend_from_slice(&(tiles.len() as u32).to_be_bytes());
        for t in tiles {
            out.extend_from_slice(&t.to_bytes());
        }
        out
    }

    /// Feeds exported tiles back in (each is CRC-checked again). Returns how
    /// many were read, or −1 if the data is not an export.
    pub fn import(&mut self, bytes: &[u8]) -> i32 {
        if bytes.len() < 8 || &bytes[..4] != EXPORT_MAGIC {
            return -1;
        }
        let count = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        let body = &bytes[8..];
        if count.checked_mul(DATA_BYTES) != Some(body.len()) {
            return -1;
        }
        let mut read = 0;
        for chunk in body.chunks_exact(DATA_BYTES) {
            let Ok(t) = Tile::from_bytes(chunk.try_into().expect("108-byte chunk")) else { continue };
            self.accept(t);
            read += 1;
        }
        self.finish();
        read
    }

    /// Everything a UI shows, as JSON.
    pub fn stats_json(&self) -> String {
        let mut j = String::with_capacity(512);
        let f = &self.frame;
        j.push('{');
        let _ = write!(j, "\"frames\":{},\"detected\":{}", self.totals.frames, f.detection.is_some());
        match &f.detection {
            Some(d) => {
                let _ = write!(
                    j,
                    ",\"grid\":{{\"w\":{},\"h\":{},\"profile\":\"{}\"}},\"corners\":{},\"finders\":{},\"polarity\":\"{}\",\
                     \"tracked\":{},\"residual\":{},\"corrected\":{}",
                    d.format.width,
                    d.format.height,
                    d.format.profile.name(),
                    points(&d.corners),
                    points(&d.finders),
                    if d.polarity == Polarity::Normal { "normal" } else { "inverted" },
                    d.tracked,
                    num(d.residual, 3),
                    d.corrected
                );
            }
            None => j.push_str(",\"grid\":null,\"corners\":null"),
        }
        let _ = write!(j, ",\"tiles\":{{\"ok\":{},\"total\":{}}}", f.tiles_ok, f.tiles);
        let t = &self.totals;
        let _ = write!(
            j,
            ",\"totals\":{{\"frames\":{},\"detections\":{},\"tiles_ok\":{},\"tiles\":{}}}",
            t.frames, t.detections, t.tiles_ok, t.tiles
        );
        let s = self.assembler.stats();
        let need = self.assembler.symbols_needed();
        let have = if self.file.is_some() { need.unwrap_or(s.symbols).max(s.symbols) } else { s.symbols };
        let _ = write!(
            j,
            ",\"symbols\":{{\"have\":{have},\"need\":{}}}",
            need.map_or("null".to_string(), |n| n.to_string())
        );
        match self.assembler.meta() {
            Some(m) => {
                let _ = write!(
                    j,
                    ",\"meta\":{{\"name\":{},\"size\":{},\"id\":\"{:08x}\",\"compression\":\"{}\"}}",
                    json_string(&sanitize_filename(&m.filename)),
                    m.size,
                    self.assembler.transfer_id().unwrap_or(0),
                    m.compression.name()
                );
            }
            None => j.push_str(",\"meta\":null"),
        }
        let _ = write!(j, ",\"limit\":{},\"too_large_count\":{}", self.limit, s.too_large);
        match self.assembler.refused() {
            Some((id, size)) => {
                let _ = write!(j, ",\"too_large\":{{\"id\":\"{id:08x}\",\"size\":{size}}}");
            }
            None => j.push_str(",\"too_large\":null"),
        }
        let _ = write!(
            j,
            ",\"foreign\":{},\"duplicates\":{},\"invalid\":{},\"failed\":{},\"done\":{},\"error\":{},\"kept\":{}",
            s.other_transfer,
            s.duplicates,
            s.invalid,
            s.failed,
            self.file.is_some(),
            self.error.as_deref().map_or("null".to_string(), json_string),
            self.kept.len()
        );
        let _ = write!(j, ",\"tile_status\":{}", json_string(&f.status));
        if self.debug {
            if let (Some(d), Some((layout, centers))) = (&f.detection, &self.centers) {
                if layout.format() == d.format {
                    let pts: Vec<Point> = centers.iter().map(|&(x, y)| d.homography.apply(x, y)).collect();
                    let _ = write!(j, ",\"tile_centers\":{}", points(&pts));
                }
            }
        }
        j.push('}');
        j
    }
}

/// Mean module coordinate of each tile's 1024 modules.
fn tile_centers(layout: &Layout) -> Vec<(f64, f64)> {
    let w = layout.width();
    (0..layout.tiles())
        .map(|n| {
            let m = layout.tile_modules(n);
            let (sx, sy) =
                m.iter().fold((0.0, 0.0), |(sx, sy), &i| (sx + (i as usize % w) as f64, sy + (i as usize / w) as f64));
            (sx / m.len() as f64 + 0.5, sy / m.len() as f64 + 0.5)
        })
        .collect()
}

fn points(p: &[Point]) -> String {
    let mut s = String::from("[");
    for (i, q) in p.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(s, "{},{}", num(q.x, 1), num(q.y, 1));
    }
    s.push(']');
    s
}

/// A JSON number with `digits` decimals; NaN and ±∞ (not JSON) become null.
fn num(v: f64, digits: usize) -> String {
    if v.is_finite() {
        format!("{v:.digits$}")
    } else {
        "null".to_string()
    }
}

/// A file name that is safe to show and to offer as a download name: path
/// separators, NUL, control characters and bidirectional-override characters
/// become `_`; an empty name, `.` or `..` becomes `file`.
pub fn sanitize_filename(name: &str) -> String {
    let bidi =
        |c: char| matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
    let clean: String =
        name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() || bidi(c) { '_' } else { c }).collect();
    match clean.as_str() {
        "" | "." | ".." => "file".to_string(),
        _ => clean,
    }
}

/// A JSON string literal.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// C ABI. wasm32 is single-threaded, so receivers live in a thread-local table
// and handles are 1-based indices into it.

thread_local! {
    static RECEIVERS: RefCell<Vec<Option<Receiver>>> = const { RefCell::new(Vec::new()) };
    static LAST_LEN: Cell<usize> = const { Cell::new(0) };
}

/// A null result: nothing to read.
fn none() -> *const u8 {
    LAST_LEN.with(|l| l.set(0));
    std::ptr::null()
}

fn with<R>(handle: u32, f: impl FnOnce(&mut Receiver) -> R) -> Option<R> {
    RECEIVERS.with(|r| {
        let mut table = r.borrow_mut();
        let slot = table.get_mut((handle as usize).checked_sub(1)?)?;
        slot.as_mut().map(f)
    })
}

/// Hands out a pointer into the receiver's output buffer.
fn hand_out(rx: &mut Receiver, bytes: Vec<u8>) -> *const u8 {
    rx.out = bytes;
    LAST_LEN.with(|l| l.set(rx.out.len()));
    rx.out.as_ptr()
}

/// Length of the buffer returned by the last `receiver_stats`/`receiver_file`/`receiver_export`.
#[no_mangle]
pub extern "C" fn last_len() -> usize {
    LAST_LEN.with(Cell::get)
}

/// Byte buffers handed to the host: size `len` (at least 1), alignment 1.
fn buffer_layout(len: usize) -> Option<std::alloc::Layout> {
    std::alloc::Layout::from_size_align(len.max(1), 1).ok()
}

/// A buffer of `len` bytes for the host to fill (null if it cannot be had);
/// release it with `dealloc(ptr, len)`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    match buffer_layout(len) {
        // SAFETY: the layout has a non-zero size.
        Some(layout) => unsafe { std::alloc::alloc(layout) },
        None => std::ptr::null_mut(),
    }
}

/// Frees a buffer from `alloc`.
///
/// # Safety
/// `ptr` must come from `alloc(len)` with the same `len`, and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if let (false, Some(layout)) = (ptr.is_null(), buffer_layout(len)) {
        // SAFETY: per the contract, ptr was returned by `alloc(len)`, i.e. allocated with this layout.
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

#[no_mangle]
pub extern "C" fn receiver_new() -> u32 {
    RECEIVERS.with(|r| {
        let mut table = r.borrow_mut();
        if let Some(i) = table.iter().position(Option::is_none) {
            table[i] = Some(Receiver::new());
            return i as u32 + 1;
        }
        table.push(Some(Receiver::new()));
        table.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn receiver_free(handle: u32) {
    RECEIVERS.with(|r| {
        if let Some(slot) = r.borrow_mut().get_mut((handle as usize).wrapping_sub(1)) {
            *slot = None;
        }
    });
}

#[no_mangle]
pub extern "C" fn receiver_reset(handle: u32) {
    with(handle, Receiver::reset);
}

#[no_mangle]
pub extern "C" fn receiver_set_debug(handle: u32, on: u32) {
    with(handle, |rx| rx.debug = on != 0);
}

/// Largest file accepted, in MiB (clamped to 1–1024).
#[no_mangle]
pub extern "C" fn receiver_set_limit(handle: u32, mib: u32) {
    let mib = mib.clamp(*LIMIT_MIB.start(), *LIMIT_MIB.end());
    with(handle, |rx| rx.set_limit(u64::from(mib) << 20));
}

/// Processes one RGBA frame of `width`×`height` at `ptr` (`len` bytes).
///
/// # Safety
/// `ptr` must point to `len` readable bytes (e.g. from `alloc`) for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn receiver_process(handle: u32, ptr: *const u8, len: usize, width: u32, height: u32) -> i32 {
    if ptr.is_null() {
        return -2;
    }
    // SAFETY: per the contract, ptr points to len initialized bytes the host owns.
    let rgba = unsafe { std::slice::from_raw_parts(ptr, len) };
    with(handle, |rx| rx.process_rgba(rgba, width as usize, height as usize)).unwrap_or(-2)
}

#[no_mangle]
pub extern "C" fn receiver_stats(handle: u32) -> *const u8 {
    with(handle, |rx| {
        let json = rx.stats_json().into_bytes();
        hand_out(rx, json)
    })
    .unwrap_or_else(none)
}

/// The verified file, in place (no copy): valid until `receiver_reset`/`receiver_free`.
#[no_mangle]
pub extern "C" fn receiver_file(handle: u32) -> *const u8 {
    with(handle, |rx| match &rx.file {
        Some(data) => {
            LAST_LEN.with(|l| l.set(data.len()));
            data.as_ptr()
        }
        None => none(),
    })
    .unwrap_or_else(none)
}

#[no_mangle]
pub extern "C" fn receiver_export(handle: u32) -> *const u8 {
    with(handle, |rx| {
        let bytes = rx.export();
        hand_out(rx, bytes)
    })
    .unwrap_or_else(none)
}

/// Feeds an export back in.
///
/// # Safety
/// `ptr` must point to `len` readable bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn receiver_import(handle: u32, ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() {
        return -1;
    }
    // SAFETY: per the contract, ptr points to len initialized bytes the host owns.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    with(handle, |rx| rx.import(bytes)).unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diodecam_core::{SendOptions, Transfer};

    #[test]
    fn filenames_are_sanitized() {
        assert_eq!(sanitize_filename("../x"), ".._x");
        assert_eq!(sanitize_filename("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_filename("evil\u{202E}fdp.exe"), "evil_fdp.exe");
        assert_eq!(sanitize_filename("bell\x07esc\x1b[0m"), "bell_esc_[0m");
        assert_eq!(sanitize_filename("nul\0"), "nul_");
        assert_eq!(sanitize_filename("\u{2066}x\u{2069}"), "_x_");
        for bad in ["", ".", ".."] {
            assert_eq!(sanitize_filename(bad), "file");
        }
        assert_eq!(sanitize_filename("보고서.pdf"), "보고서.pdf");
    }

    #[test]
    fn json_escaping() {
        assert_eq!(json_string("a\"\\\n\u{2028}"), "\"a\\\"\\\\\\u000a\\u2028\"");
    }

    #[test]
    fn export_import_resumes_a_transfer() {
        let data: Vec<u8> = (0..20_000u32).map(|i| (i * 31 % 251) as u8).collect();
        let mut tx = Transfer::prepare(&data, "a/b.bin", SendOptions { compress: false }, 0).unwrap();
        let mut rx = Receiver::new();
        // Half the symbols, then a "reload".
        let k = tx.source_symbols() as usize;
        let mut fed = 0;
        while fed < k / 2 {
            for t in tx.next_frame_tiles(7) {
                rx.accept(t);
                fed += 1;
            }
        }
        let saved = rx.export();
        assert!(saved.len() > 8 + DATA_BYTES * (k / 2 - 10));
        let mut fresh = Receiver::new();
        assert!(fresh.import(&saved) > 0);
        assert!(fresh.stats_json().contains("\"name\":\"a_b.bin\""));
        while fresh.file().is_none() {
            for t in tx.next_frame_tiles(7) {
                fresh.accept(t);
            }
            fresh.finish();
        }
        assert_eq!(fresh.file(), Some(&data[..]));
        assert_eq!(fresh.import(b"nope"), -1);
    }

    fn meta_tile(meta: &diodecam_core::Meta) -> Tile {
        let bytes = meta.to_bytes();
        Tile::meta(diodecam_core::Meta::from_bytes(&bytes).unwrap().tag(), bytes)
    }

    fn export_of(tiles: &[Tile]) -> Vec<u8> {
        let mut out = EXPORT_MAGIC.to_vec();
        out.extend_from_slice(&(tiles.len() as u32).to_be_bytes());
        for t in tiles {
            out.extend_from_slice(&t.to_bytes());
        }
        out
    }

    fn field<'a>(json: &'a str, key: &str) -> &'a str {
        let i = json.find(&format!("\"{key}\":")).unwrap() + key.len() + 3;
        let rest = &json[i..];
        let end = if rest.starts_with('{') { rest.find('}').unwrap() + 1 } else { rest.find([',', '}']).unwrap() };
        &rest[..end]
    }

    #[test]
    fn oversized_meta_is_refused_and_shown() {
        use diodecam_core::meta::Compression;
        let f = 255 * 56_403 * 96u64;
        let meta = diodecam_core::Meta {
            size: f,
            sha256: [0x11; 32],
            compression: Compression::None,
            oti: raptorq_oti(f),
            filename: "huge.bin".into(),
        };
        let mut rx = Receiver::new();
        assert_eq!(rx.import(&export_of(&[meta_tile(&meta)])), 1);
        let json = rx.stats_json();
        assert_eq!(field(&json, "meta"), "null");
        assert!(field(&json, "too_large").contains(&format!("\"size\":{f}")), "{json}");
        assert_eq!(field(&json, "limit"), (64u64 << 20).to_string());
        assert_eq!(rx.export().len(), 8, "nothing kept for a refused transfer");
        // Raising the limit lets the same META through.
        let mut rx = Receiver::new();
        rx.set_limit(u64::MAX);
        rx.import(&export_of(&[meta_tile(&meta)]));
        assert_ne!(field(&rx.stats_json(), "meta"), "null");
    }

    fn raptorq_oti(f: u64) -> [u8; 12] {
        let mut oti = [0u8; 12];
        oti[..5].copy_from_slice(&f.to_be_bytes()[3..]);
        oti[6..8].copy_from_slice(&96u16.to_be_bytes());
        oti[8] = 255; // Z
        oti[9..11].copy_from_slice(&1u16.to_be_bytes()); // N
        oti[11] = 8; // Al
        oti
    }

    #[test]
    fn bad_empty_meta_is_kept_once_and_then_refused() {
        use diodecam_core::meta::Compression;
        let meta = diodecam_core::Meta {
            size: 0,
            sha256: [0x33; 32],
            compression: Compression::None,
            oti: [0; 12],
            filename: "e".into(),
        };
        let bytes = export_of(&[meta_tile(&meta)]);
        let mut rx = Receiver::new();
        for _ in 0..1000 {
            rx.import(&bytes);
        }
        let json = rx.stats_json();
        assert_eq!(field(&json, "kept"), "0");
        assert_eq!(field(&json, "failed"), "1");
        assert_eq!(field(&json, "done"), "false");
        assert!(rx.export().len() <= 8 + DATA_BYTES);
    }

    #[test]
    fn meta_completing_a_replay_is_kept_for_export() {
        let data: Vec<u8> = (0..3000u32).map(|i| (i * 31 + i / 7) as u8).collect();
        let mut tx = Transfer::prepare(&data, "a.bin", SendOptions { compress: false }, 0).unwrap();
        let tag = tx.meta().tag();
        let k = tx.source_symbols() as usize;
        let mut tiles: Vec<Tile> = (0..8).flat_map(|_| tx.next_frame_tiles(7)).collect();
        let meta = tiles.iter().find(|t| t.kind == TileKind::Meta).unwrap().clone();
        tiles.retain(|t| t.kind == TileKind::Data);
        // A same-tag foreign symbol, K − 1 genuine ones, then META: the replay
        // completes a poisoned decode, verification fails and restarts.
        let mut seq = vec![Tile::data(tag, 0, 0, [0xA5; 96])];
        seq.extend(tiles.iter().filter(|t| t.esi != 0).take(k - 1).cloned());
        seq.push(meta);
        let mut rx = Receiver::new();
        rx.import(&export_of(&seq));
        let json = rx.stats_json();
        assert_eq!((field(&json, "failed"), field(&json, "done")), ("1", "false"));
        let saved = rx.export();
        assert_eq!(saved.len(), 8 + DATA_BYTES, "only META survives the restart, and it does survive");
        // A reload from that export plus fresh frames completes.
        let mut fresh = Receiver::new();
        fresh.import(&saved);
        for _ in 0..200 {
            if fresh.file().is_some() {
                break;
            }
            let frame: Vec<Tile> = tx.next_frame_tiles(7);
            fresh.import(&export_of(&frame));
        }
        assert_eq!(fresh.file(), Some(&data[..]));
    }

    #[test]
    fn non_finite_numbers_become_null() {
        assert_eq!(num(f64::NAN, 3), "null");
        assert_eq!(num(f64::INFINITY, 1), "null");
        assert_eq!(num(1.25, 1), "1.2");
        assert_eq!(points(&[Point::new(f64::NEG_INFINITY, 2.0)]), "[null,2.0]");
    }

    #[test]
    fn file_is_handed_out_in_place() {
        let mut t = Transfer::prepare(b"hello world", "h.txt", SendOptions { compress: false }, 0).unwrap();
        let h = receiver_new();
        let tiles = export_of(&t.next_frame_tiles(2));
        // SAFETY: the slice outlives the call.
        assert!(unsafe { receiver_import(h, tiles.as_ptr(), tiles.len()) } > 0);
        let p = receiver_file(h);
        assert!(!p.is_null());
        // SAFETY: receiver_file returned last_len() bytes owned by the receiver.
        let got = unsafe { std::slice::from_raw_parts(p, last_len()) };
        assert_eq!(got, b"hello world");
        let inner = with(h, |rx| rx.file.as_ref().map(|f| f.as_ptr())).flatten();
        assert_eq!(inner, Some(p), "no copy");
        receiver_free(h);
    }

    #[test]
    fn invalid_handles_reset_last_len() {
        let h = receiver_new();
        assert!(!receiver_stats(h).is_null());
        assert!(last_len() > 0);
        for f in [receiver_stats, receiver_file, receiver_export] {
            assert!(f(h + 1000).is_null());
            assert_eq!(last_len(), 0);
        }
        receiver_free(h);
    }

    #[test]
    fn limit_is_clamped_and_survives_reset() {
        let h = receiver_new();
        receiver_set_limit(h, 0);
        assert_eq!(with(h, |rx| rx.limit), Some(1 << 20));
        receiver_set_limit(h, u32::MAX);
        assert_eq!(with(h, |rx| rx.limit), Some(1024 << 20));
        receiver_set_limit(h, 8);
        receiver_reset(h);
        assert_eq!(with(h, |rx| (rx.limit, rx.assembler.limit())), Some((8 << 20, 8 << 20)));
        receiver_free(h);
    }

    #[test]
    fn oversized_frames_are_rejected_without_overflow() {
        let mut rx = Receiver::new();
        assert_eq!(rx.process_rgba(&[0; 16], 65536, 65536), -2);
        assert_eq!(rx.process_rgba(&[0; 16], usize::MAX, 2), -2);
        assert_eq!(rx.process_gray(&[0; 16], usize::MAX, 3), -2);
        assert_eq!(rx.import(&[b'O', b'C', b'S', b'1', 0xFF, 0xFF, 0xFF, 0xFF]), -1);
    }

    #[test]
    fn abi_round_trip() {
        let h = receiver_new();
        assert!(h > 0);
        let p = alloc(64 * 64 * 4);
        // SAFETY: p is a fresh 16 KiB allocation; zero it before use.
        unsafe {
            std::ptr::write_bytes(p, 0, 64 * 64 * 4);
            assert_eq!(receiver_process(h, p, 64 * 64 * 4, 64, 64), -1);
            assert_eq!(receiver_process(h, p, 10, 64, 64), -2);
            dealloc(p, 64 * 64 * 4);
        }
        let s = receiver_stats(h);
        assert!(!s.is_null());
        // SAFETY: receiver_stats returned a pointer to last_len() bytes owned by the receiver.
        let json = unsafe { std::slice::from_raw_parts(s, last_len()) };
        let json = std::str::from_utf8(json).unwrap();
        assert!(json.starts_with('{') && json.contains("\"detected\":false") && json.contains("\"done\":false"));
        assert!(receiver_file(h).is_null());
        receiver_free(h);
        // SAFETY: a null pointer is rejected before it is read.
        assert_eq!(unsafe { receiver_process(h, std::ptr::null(), 0, 1, 1) }, -2);
        assert!(receiver_stats(h).is_null());
    }
}
