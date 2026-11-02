//! The two status lines (`docs/cli.md`) and their number formats.

use std::time::Duration;

use diodecam_core::meta::Compression;
use diodecam_core::sender::{data_tiles_per_frame, view_seconds};
use diodecam_core::tile::CONTENT_BYTES;
use diodecam_core::{Layout, Profile, Transfer};

/// What the status bar shows; the sender fills it in every frame.
pub struct Status<'a> {
    pub name: &'a str,
    pub size: u64,
    pub payload: u64,
    pub compression: Compression,
    pub id: u32,
    pub profile: Profile,
    /// (W, H, tiles) of the current layout; `None` while the terminal is too small.
    pub grid: Option<(usize, usize, usize)>,
    pub elapsed: Duration,
    pub source_progress: f64,
    pub repair_sent: u64,
    pub source_symbols: u64,
    pub target_fps: u32,
    /// Frames per second actually written, once measured.
    pub actual_fps: Option<f64>,
    pub paused: bool,
    /// Shown in place of the key hints, e.g. the 30-fps phase-lock hint.
    pub notice: Option<&'a str>,
}

impl Status<'_> {
    /// The transfer-derived fields (the META name, as `send` shows it); the clock
    /// starts at zero, with no measured fps, not paused and no notice. Callers set
    /// their own fields with struct-update syntax.
    pub fn for_transfer<'a>(tx: &'a Transfer, profile: Profile, layout: Option<&Layout>, fps: u32) -> Status<'a> {
        let meta = tx.meta();
        Status {
            name: &meta.filename,
            size: meta.size,
            payload: tx.payload_len(),
            compression: meta.compression,
            id: tx.id(),
            profile,
            grid: layout.map(|l| (l.width(), l.height(), l.tiles())),
            elapsed: Duration::ZERO,
            source_progress: tx.source_progress(),
            repair_sent: tx.repair_sent(),
            source_symbols: tx.source_symbols(),
            target_fps: fps,
            actual_fps: None,
            paused: false,
            notice: None,
        }
    }
}

/// Both lines, each at most `cols − 1` characters. When they do not fit, the
/// key hints go first, then the progress bar, then the transfer ID.
pub fn lines(s: &Status, cols: usize) -> [String; 2] {
    let width = cols.saturating_sub(1);
    let mut last = [String::new(), String::new()];
    for level in 0..=3 {
        last = [line1(s, level < 3), line2(s, level < 1, level < 2)];
        if last.iter().all(|l| l.len() <= width) {
            break;
        }
    }
    last.map(|l| l.chars().take(width).collect())
}

fn line1(s: &Status, with_id: bool) -> String {
    let mut parts = vec![" DiodeCam".to_string()];
    let mut file = format!("{} {}", ascii(s.name), bytes(s.size));
    if s.compression == Compression::DeflateRaw {
        file += &format!(" -> {} deflate", bytes(s.payload));
    }
    parts.push(file);
    if with_id {
        parts.push(format!("id {:08x}", s.id));
    }
    match s.grid {
        Some((w, h, tiles)) => {
            parts.push(format!("{} {w}x{h}", s.profile));
            let per_frame = data_tiles_per_frame(tiles) * CONTENT_BYTES as f64;
            parts.push(format!("{tiles} tiles {}/frame", bytes_f(per_frame)));
        }
        None => parts.push(format!("{} terminal too small", s.profile)),
    }
    parts.join("  ")
}

fn line2(s: &Status, with_keys: bool, with_bar: bool) -> String {
    let mut parts = vec![format!(" {}", clock(s.elapsed))];
    if s.paused {
        parts.push("PAUSED".into());
    }
    let pct = (s.source_progress * 100.0).floor().min(100.0);
    let mut source = format!("source {pct:.0}%");
    if with_bar {
        let filled = ((s.source_progress * 10.0).floor() as usize).min(10);
        source += &format!(" [{}{}]", "#".repeat(filled), ".".repeat(10 - filled));
    }
    parts.push(source);
    parts.push(format!("+repair {}", thousands(s.repair_sent)));
    let fps = s.actual_fps.unwrap_or(s.target_fps as f64);
    parts.push(match s.actual_fps {
        Some(a) if a.round() as u32 != s.target_fps => format!("{}/{:.0} fps", s.target_fps, a),
        _ => format!("{} fps", s.target_fps),
    });
    if let Some((_, _, tiles)) = s.grid {
        let rate = fps * data_tiles_per_frame(tiles) * CONTENT_BYTES as f64;
        parts.push(format!("{}/s", bytes_f(rate)));
        let need = view_seconds(s.source_symbols, tiles, fps.max(0.1));
        parts.push(format!("phone needs {} of view", approx(need)));
    }
    if with_keys {
        parts.push(s.notice.unwrap_or("[+/-] fps [space] pause [q] quit").into());
    }
    parts.join("  ")
}

/// Replaces anything but printable ASCII so the status bar stays one cell per byte.
pub fn ascii(s: &str) -> String {
    s.chars().map(|c| if (' '..='~').contains(&c) { c } else { '?' }).collect()
}

/// SI sizes with three significant digits: "96 B", "1.73 KB", "412 KB", "1.00 MB".
pub fn bytes(n: u64) -> String {
    bytes_f(n as f64)
}

pub fn bytes_f(n: f64) -> String {
    if n < 999.5 {
        return format!("{n:.0} B");
    }
    let mut v = n;
    for unit in ["KB", "MB", "GB", "TB"] {
        v /= 1000.0;
        if v < 999.5 || unit == "TB" {
            return match v {
                v if v < 9.995 => format!("{v:.2} {unit}"),
                v if v < 99.95 => format!("{v:.1} {unit}"),
                v => format!("{v:.0} {unit}"),
            };
        }
    }
    unreachable!()
}

/// "3,120".
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// "00:41", or "1:02:03" past an hour.
pub fn clock(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

/// "~40s", "~2m45s", "~1h05m".
pub fn approx(seconds: f64) -> String {
    let s = seconds.ceil().max(0.0) as u64;
    match s {
        0..60 => format!("~{s}s"),
        60..3600 => format!("~{}m{:02}s", s / 60, s % 60),
        _ => format!("~{}h{:02}m", s / 3600, s / 60 % 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Status<'static> {
        Status {
            name: "report.pdf",
            size: 1_000_000,
            payload: 412_000,
            compression: Compression::DeflateRaw,
            id: 0x3f2a_9c1e,
            profile: Profile::Ssh,
            grid: Some((199, 106, 19)),
            elapsed: Duration::from_secs(41),
            source_progress: 1.0,
            repair_sent: 13_420,
            source_symbols: 4292,
            target_fps: 24,
            actual_fps: None,
            paused: false,
            notice: None,
        }
    }

    #[test]
    fn full_width_matches_spec_example() {
        let [a, b] = lines(&sample(), 200);
        assert_eq!(
            a,
            " DiodeCam  report.pdf 1.00 MB -> 412 KB deflate  id 3f2a9c1e  ssh 199x106  19 tiles 1.73 KB/frame"
        );
        assert_eq!(
            b,
            " 00:41  source 100% [##########]  +repair 13,420  24 fps  41.5 KB/s  phone needs ~10s of view  [+/-] fps [space] pause [q] quit"
        );
    }

    #[test]
    fn truncation_order() {
        let s = sample();
        let [a, b] = lines(&s, 128);
        assert!(b.ends_with("[q] quit") && a.contains("id 3f2a9c1e"));
        // Key hints go first...
        let [a, b] = lines(&s, 110);
        assert!(!b.contains("[q] quit") && b.contains("[####") && a.contains("id 3f2a9c1e"), "{a} | {b}");
        // ...then the progress bar, then the ID.
        let [a, b] = lines(&s, 95);
        assert!(!b.contains('#') && !a.contains("id ") && a.len() <= 94, "{a} | {b}");
        assert!(a.ends_with("KB/frame") && b.ends_with("of view"));
        // Narrower still: hard cut at cols - 1.
        for cols in [1, 10, 40, 80] {
            let [a, b] = lines(&s, cols);
            assert!(a.len() < cols.max(1) && b.len() < cols.max(1));
        }
    }

    #[test]
    fn paused_and_slow_fps() {
        let mut s = sample();
        s.paused = true;
        s.actual_fps = Some(11.2);
        let [_, b] = lines(&s, 200);
        assert!(b.starts_with(" 00:41  PAUSED  source"), "{b}");
        assert!(b.contains("24/11 fps"));
        s.actual_fps = Some(23.8);
        assert!(lines(&s, 200)[1].contains(" 24 fps"));
    }

    #[test]
    fn formats() {
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(999), "999 B");
        assert_eq!(bytes(1000), "1.00 KB");
        assert_eq!(bytes(25_920), "25.9 KB");
        assert_eq!(bytes(412_000), "412 KB");
        assert_eq!(bytes(67_108_864), "67.1 MB");
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(3120), "3,120");
        assert_eq!(thousands(1_234_567), "1,234,567");
        assert_eq!(clock(Duration::from_secs(3723)), "1:02:03");
        assert_eq!(approx(39.2), "~40s");
        assert_eq!(approx(165.0), "~2m45s");
        assert_eq!(approx(3900.0), "~1h05m");
        assert_eq!(ascii("보고서.pdf"), "???.pdf");
    }
}
