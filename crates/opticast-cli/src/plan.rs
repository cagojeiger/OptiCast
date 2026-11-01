//! `opticast plan`: layout and expected transfer time for a few terminal sizes.

use std::io::{self, IsTerminal, Write};
use std::time::Duration;

use crossterm::terminal;
use opticast_core::layout::{min_rows, MIN_WIDTH};
use opticast_core::meta::Compression;
use opticast_core::sender::{data_tiles_per_frame, view_seconds, MAX_PAYLOAD_BYTES};
use opticast_core::tile::CONTENT_BYTES;
use opticast_core::{ansi, frame, Layout, Profile, SendOptions, Transfer};

use crate::status::{self, approx, ascii, bytes, bytes_f, thousands, Status};
use crate::{input, PlanArgs, DEFAULT_MAX_BYTES};

const SIZES: [(usize, usize); 3] = [(80, 24), (120, 40), (200, 55)];

pub fn run(args: &PlanArgs, profile: Profile) -> Result<(), String> {
    let input = input::load(&args.file, MAX_PAYLOAD_BYTES)?;
    let size = input.data.len() as u64;
    let mut transfer =
        Transfer::prepare(&input.data, &input.name, SendOptions::default(), 0).map_err(|e| e.to_string())?;
    let meta = transfer.meta().clone();
    let k = transfer.source_symbols();

    let mut rows: Vec<(String, usize, usize)> = Vec::new();
    match (args.cols, args.rows) {
        (Some(c), Some(r)) => rows.push((format!("{c}x{r} (given)"), c as usize, r as usize)),
        _ => match terminal::size() {
            Ok((c, r)) if io::stdout().is_terminal() => rows.push((format!("{c}x{r} (this)"), c as usize, r as usize)),
            _ => {}
        },
    }
    rows.extend(SIZES.iter().map(|&(c, r)| (format!("{c}x{r}"), c, r)));

    let mut out = String::new();
    let compression = match meta.compression {
        Compression::DeflateRaw => format!("-> {} deflate", bytes(transfer.payload_len())),
        Compression::None => "(not compressed)".into(),
    };
    out += &format!(
        "{}  {} {}  id {:08x}\nK = {} source symbols in {} block(s), T = 96; profile {}\n",
        ascii(&input.name),
        bytes(size),
        compression,
        transfer.id(),
        thousands(k),
        transfer.source_blocks(),
        profile
    );
    if size > DEFAULT_MAX_BYTES {
        out += "note: larger than the default limit; send needs --max-bytes\n";
    }
    out += &format!(
        "\n{:<16}{:>9}{:>7}{:>12}{:>13}{:>18}{:>8}{:>9}\n",
        "terminal", "grid", "tiles", "data/frame", "frame bytes", "phone needs @10", "@15", "@24 fps"
    );
    for (label, cols, rows) in rows {
        let layout = match Layout::for_terminal(profile, cols, rows) {
            Ok(layout) => layout,
            Err(_) => {
                let need = min_rows(profile, cols.max(MIN_WIDTH + 1))
                    .map_or(String::new(), |r| format!(" (minimum {}x{r})", cols.max(MIN_WIDTH + 1)));
                out += &format!("{label:<16}{:>9}  too small{need}\n", "-");
                continue;
            }
        };
        let tiles = layout.tiles();
        // Frame bytes: render a real frame, status bar included.
        let grid = frame::render(&layout, &transfer.next_frame(&layout));
        let status = status::lines(
            &Status {
                name: &input.name,
                size,
                payload: transfer.payload_len(),
                compression: meta.compression,
                id: transfer.id(),
                profile,
                grid: Some((layout.width(), layout.height(), tiles)),
                elapsed: Duration::ZERO,
                source_progress: 0.0,
                repair_sent: 0,
                source_symbols: k,
                target_fps: crate::DEFAULT_FPS,
                actual_fps: None,
                paused: false,
                notice: None,
            },
            cols,
        );
        let frame_bytes = ansi::frame(&grid, profile, cols, rows, [&status[0], &status[1]], false).len();
        out += &format!(
            "{label:<16}{:>9}{:>7}{:>12}{:>13}{:>18}{:>8}{:>9}\n",
            format!("{}x{}", layout.width(), layout.height()),
            tiles,
            bytes_f(data_tiles_per_frame(tiles) * CONTENT_BYTES as f64),
            bytes(frame_bytes as u64),
            approx(view_seconds(k, tiles, 10.0)),
            approx(view_seconds(k, tiles, 15.0)),
            approx(view_seconds(k, tiles, 24.0)),
        );
    }
    out += "\n\"phone needs\" = (K + 2) symbols / DATA symbols per second, with no loss.\n";
    io::stdout().write_all(out.as_bytes()).map_err(|e| format!("cannot write output: {e}"))
}
