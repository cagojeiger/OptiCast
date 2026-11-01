//! `diodecam frames` (hidden): writes the exact ANSI text of consecutive frames
//! to a file, so receiver tests can replay a real sender without a terminal.
//!
//! Output is JSON lines: one header object, then `{"index": f, "ansi": "…"}`
//! per frame f (counted from the start of the broadcast, so it includes `--skip`).
//! Frames are what `send` writes per frame, without the one-time ENTER/LEAVE
//! sequences; the first one written starts with a screen clear.

use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write};

use diodecam_core::{ansi, frame, Layout, Profile, SendOptions, Transfer};

use crate::args::{FramesArgs, ProfileArg};

pub fn run(args: &FramesArgs) -> Result<(), String> {
    let shown = args.file.display().to_string();
    let data = std::fs::read(&args.file).map_err(|e| format!("{shown}: cannot read: {e}"))?;
    let name = args.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let profile = match args.profile {
        ProfileArg::Vt100 => Profile::Vt100,
        ProfileArg::Ssh | ProfileArg::Auto => Profile::Ssh,
    };
    let (cols, rows) = (args.cols as usize, args.rows as usize);
    let layout = Layout::for_terminal(profile, cols, rows).map_err(|e| e.to_string())?;
    let mut tx = Transfer::prepare(&data, &name, SendOptions { compress: !args.no_compress }, args.r0)
        .map_err(|e| e.to_string())?;
    let meta = tx.meta().clone();

    let file = File::create(&args.out).map_err(|e| format!("{}: {e}", args.out.display()))?;
    let mut out = BufWriter::new(file);
    let header = format!(
        "{{\"format\":\"diodecam-frames\",\"version\":1,\"cols\":{cols},\"rows\":{rows},\"profile\":\"{}\",\
         \"width\":{},\"height\":{},\"tiles\":{},\"id\":\"{:08x}\",\"name\":{},\"size\":{},\"payload\":{},\
         \"compression\":\"{}\",\"source_symbols\":{},\"skip\":{},\"count\":{}}}",
        profile.name(),
        layout.width(),
        layout.height(),
        layout.tiles(),
        tx.id(),
        json_string(&meta.filename),
        meta.size,
        tx.payload_len(),
        meta.compression.name(),
        tx.source_symbols(),
        args.skip,
        args.count,
    );
    let io = |e: std::io::Error| format!("{}: {e}", args.out.display());
    writeln!(out, "{header}").map_err(io)?;
    for _ in 0..args.skip {
        tx.next_frame_tiles(layout.tiles());
    }
    for i in 0..args.count {
        let f = args.skip + i;
        let grid = frame::render(&layout, &tx.next_frame(&layout));
        let status = [
            format!(
                " DiodeCam  {}  id {:08x}  {} {}x{}",
                ascii(&name),
                tx.id(),
                profile,
                layout.width(),
                layout.height()
            ),
            format!(" frame {f}  {} tiles", layout.tiles()),
        ];
        let text = ansi::frame(&grid, profile, cols, rows, [&status[0], &status[1]], i == 0);
        writeln!(out, "{{\"index\":{f},\"ansi\":{}}}", json_string(&text)).map_err(io)?;
    }
    out.flush().map_err(io)
}

/// Printable ASCII only, like the status bar.
fn ascii(s: &str) -> String {
    s.chars().map(|c| if (' '..='~').contains(&c) { c } else { '?' }).collect()
}

/// A JSON string literal: quotes, backslashes and control characters escaped.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escapes() {
        assert_eq!(json_string("a\"b\\c\x1b[7m▀\n"), "\"a\\\"b\\\\c\\u001b[7m▀\\u000a\"");
    }

    #[test]
    fn writes_parseable_frames() {
        let dir = std::env::temp_dir().join(format!("diodecam-frames-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.bin");
        std::fs::write(&input, (0..20_000u32).map(|i| (i * 7) as u8).collect::<Vec<_>>()).unwrap();
        let out = dir.join("frames.jsonl");
        let args = FramesArgs {
            file: input,
            cols: 120,
            rows: 40,
            count: 3,
            skip: 2,
            profile: ProfileArg::Ssh,
            r0: 0,
            no_compress: true,
            out: out.clone(),
        };
        run(&args).unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("\"width\":119") && lines[0].contains("\"tiles\":7"));
        assert!(lines[1].starts_with("{\"index\":2,"));
        assert!(lines[3].starts_with("{\"index\":4,"));
        // The ANSI text round-trips through the core's terminal parser.
        let ansi = lines[2].split("\"ansi\":\"").nth(1).unwrap().trim_end_matches("\"}");
        let ansi = ansi.replace("\\u001b", "\x1b").replace("\\\"", "\"").replace("\\\\", "\\");
        let parsed = ansi::parse_screen(&ansi, 120, 40).expect("frame on screen");
        assert_eq!((parsed.format.width, parsed.format.height), (119, 76));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
