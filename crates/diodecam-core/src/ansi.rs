//! Terminal encoding (spec §2.1, §2.2) and its inverse.
//!
//! [`frame`] turns a module grid into the exact bytes the sender writes.
//! [`Screen`] / [`parse_screen`] read terminal output — raw sender bytes or
//! `tmux capture-pane -p -e` text — back into a module grid. The parser knows
//! CUP, SGR 0/7/27, ED/EL, newlines, and skips every other escape sequence.

use std::fmt::Write as _;

use crate::frame::{self, ModuleGrid};
use crate::layout::{FormatInfo, Profile, STATUS_ROWS};

/// Sent once at start: alternate screen, hide cursor, no autowrap, clear.
pub const ENTER: &str = "\x1b[m\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J";
/// Sent once at exit: reset SGR, autowrap on, show cursor, main screen.
pub const LEAVE: &str = "\x1b[?2026l\x1b[m\x1b[?7h\x1b[?25h\x1b[?1049l";
/// Prefixed to the first frame after a layout change.
pub const CLEAR: &str = "\x1b[2J";
pub const SYNC_BEGIN: &str = "\x1b[?2026h";
pub const SYNC_END: &str = "\x1b[?2026l";

const REVERSE: &str = "\x1b[7m";
const NORMAL: &str = "\x1b[m";
const UPPER_HALF: char = '▀';

/// One frame as written by the sender: `[CLEAR] SYNC_BEGIN rows status SYNC_END`.
/// Each grid row starts with a CUP, toggles reverse video only when the
/// background module changes, and ends with `ESC[m`. The two status lines go
/// to the last two terminal rows, padded or cut to `cols − 1` columns.
pub fn frame(grid: &ModuleGrid, profile: Profile, cols: usize, rows: usize, status: [&str; 2], clear: bool) -> String {
    let mut out = String::with_capacity(grid.width() * grid.height() * 2 + 64);
    if clear {
        out.push_str(CLEAR);
    }
    out.push_str(SYNC_BEGIN);
    let cells_per_row = profile.modules_per_cell();
    for row in 0..grid.height() / cells_per_row {
        cup(&mut out, row + 1);
        let mut reverse = false;
        for x in 0..grid.width() {
            // ssh: the cell background carries the bottom module, the glyph the top one.
            let (top, background) = match profile {
                Profile::Ssh => (grid.get(x, 2 * row), grid.get(x, 2 * row + 1)),
                Profile::Vt100 => (grid.get(x, row), grid.get(x, row)),
            };
            if background != reverse {
                out.push_str(if background { REVERSE } else { NORMAL });
                reverse = background;
            }
            out.push(if top == background { ' ' } else { UPPER_HALF });
        }
        out.push_str(NORMAL);
    }
    status_lines(&mut out, cols, rows, status);
    out.push_str(SYNC_END);
    out
}

/// A frame without a grid (e.g. "terminal too small"): `lines` from the top,
/// plus the status lines. Same framing as [`frame`].
pub fn message_frame(lines: &[&str], cols: usize, rows: usize, status: [&str; 2], clear: bool) -> String {
    let mut out = String::new();
    if clear {
        out.push_str(CLEAR);
    }
    out.push_str(SYNC_BEGIN);
    for (i, line) in lines.iter().take(rows.saturating_sub(STATUS_ROWS)).enumerate() {
        cup(&mut out, i + 1);
        padded(&mut out, line, cols);
    }
    status_lines(&mut out, cols, rows, status);
    out.push_str(SYNC_END);
    out
}

fn status_lines(out: &mut String, cols: usize, rows: usize, status: [&str; 2]) {
    if rows < STATUS_ROWS {
        return;
    }
    for (i, line) in status.iter().enumerate() {
        cup(out, rows - STATUS_ROWS + 1 + i);
        padded(out, line, cols);
    }
}

/// `text` cut or space-padded to exactly `cols − 1` characters.
fn padded(out: &mut String, text: &str, cols: usize) {
    let width = cols.saturating_sub(1);
    let mut n = 0;
    for c in text.chars().take(width) {
        out.push(c);
        n += 1;
    }
    out.extend(std::iter::repeat_n(' ', width - n));
}

fn cup(out: &mut String, row: usize) {
    let _ = write!(out, "\x1b[{row};1H");
}

/// One terminal cell as far as DiodeCam cares: the character and reverse video.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub reverse: bool,
}

const BLANK: Cell = Cell { ch: ' ', reverse: false };

/// A minimal terminal emulator holding a `cols` × `rows` screen. Feed it
/// output in any number of pieces; the cursor and SGR state carry over.
#[derive(Clone, Debug)]
pub struct Screen {
    cols: usize,
    rows: usize,
    cells: Vec<Cell>,
    row: usize,
    col: usize,
    reverse: bool,
}

/// A frame recovered from a screen: its format information and the module grid
/// sampled at that size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedFrame {
    pub format: FormatInfo,
    pub grid: ModuleGrid,
}

/// Parses `text` on a blank `cols` × `rows` screen and recovers the frame on it.
/// Works for raw sender output and for `tmux capture-pane -p -e [-N]` output.
pub fn parse_screen(text: &str, cols: usize, rows: usize) -> Option<ParsedFrame> {
    let mut screen = Screen::new(cols, rows);
    screen.feed(text);
    screen.decode()
}

impl Screen {
    pub fn new(cols: usize, rows: usize) -> Screen {
        Screen { cols, rows, cells: vec![BLANK; cols * rows], row: 0, col: 0, reverse: false }
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    /// The cell at (x, y); blank outside the screen.
    pub fn cell(&self, x: usize, y: usize) -> Cell {
        if x < self.cols && y < self.rows {
            self.cells[y * self.cols + x]
        } else {
            BLANK
        }
    }

    /// Row `y` as plain text (e.g. to read the status bar).
    pub fn line(&self, y: usize) -> String {
        (0..self.cols).map(|x| self.cell(x, y).ch).collect()
    }

    /// Applies terminal output to the screen.
    pub fn feed(&mut self, text: &str) {
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            match c {
                '\x1b' => self.escape(&mut chars),
                '\n' => {
                    // capture-pane separates lines with a bare LF.
                    self.row = (self.row + 1).min(self.rows);
                    self.col = 0;
                }
                '\r' => self.col = 0,
                '\x08' => self.col = self.col.saturating_sub(1),
                '\t' => self.col = ((self.col / 8 + 1) * 8).min(self.cols.saturating_sub(1)),
                c if (c as u32) < 0x20 || c == '\x7f' => {}
                c => self.put(c),
            }
        }
    }

    fn put(&mut self, ch: char) {
        if self.row >= self.rows || self.cols == 0 {
            return;
        }
        // Autowrap is off: at the right margin the last column is overwritten.
        let x = self.col.min(self.cols - 1);
        self.cells[self.row * self.cols + x] = Cell { ch, reverse: self.reverse };
        self.col = (x + 1).min(self.cols - 1);
    }

    fn escape(&mut self, chars: &mut std::str::Chars<'_>) {
        match chars.next() {
            Some('[') => {
                let mut params = String::new();
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        self.csi(&params, c);
                        return;
                    }
                    params.push(c);
                }
            }
            // OSC / DCS / SOS / PM / APC: skip to BEL or ST.
            Some(']' | 'P' | 'X' | '^' | '_') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            // Charset designation takes one more character.
            Some('(' | ')' | '*' | '+') => {
                chars.next();
            }
            _ => {}
        }
    }

    fn csi(&mut self, params: &str, final_byte: char) {
        // Private modes (?2026h, ?1049h, ...) and other prefixed sequences are ignored.
        if params.starts_with(['?', '>', '<', '=']) {
            return;
        }
        let nums: Vec<Option<usize>> = params.split(';').map(|p| p.parse().ok()).collect();
        let arg = |i: usize, default: usize| nums.get(i).copied().flatten().filter(|&n| n > 0).unwrap_or(default);
        let last_row = self.rows.saturating_sub(1);
        let last_col = self.cols.saturating_sub(1);
        match final_byte {
            'H' | 'f' => {
                self.row = (arg(0, 1) - 1).min(last_row);
                self.col = (arg(1, 1) - 1).min(last_col);
            }
            'A' => self.row = self.row.saturating_sub(arg(0, 1)),
            'B' => self.row = (self.row + arg(0, 1)).min(last_row),
            'C' => self.col = (self.col + arg(0, 1)).min(last_col),
            'D' => self.col = self.col.saturating_sub(arg(0, 1)),
            'G' => self.col = (arg(0, 1) - 1).min(last_col),
            'd' => self.row = (arg(0, 1) - 1).min(last_row),
            'm' => self.sgr(params),
            'J' => {
                let len = self.cells.len();
                let cursor = (self.row.min(self.rows) * self.cols + self.col).min(len);
                match nums.first().copied().flatten().unwrap_or(0) {
                    0 => self.cells[cursor..].fill(BLANK),
                    1 => self.cells[..(cursor + 1).min(len)].fill(BLANK),
                    _ => self.cells.fill(BLANK),
                }
            }
            'K' if self.row < self.rows => {
                let start = self.row * self.cols;
                let line = &mut self.cells[start..start + self.cols];
                match nums.first().copied().flatten().unwrap_or(0) {
                    0 => line[self.col.min(self.cols)..].fill(BLANK),
                    1 => line[..(self.col + 1).min(self.cols)].fill(BLANK),
                    _ => line.fill(BLANK),
                }
            }
            _ => {}
        }
    }

    /// SGR: only reverse video matters. 0 and 27 turn it off, 7 on; colors and
    /// other attributes are skipped, including the arguments of 38/48/58.
    fn sgr(&mut self, params: &str) {
        let parts: Vec<&str> = params.split(';').collect();
        let mut i = 0;
        while i < parts.len() {
            let part = parts[i];
            i += 1;
            if part.contains(':') {
                continue; // colon sub-parameters are self-contained (38:2::r:g:b)
            }
            match part.parse::<u32>().unwrap_or(0) {
                0 | 27 => self.reverse = false,
                7 => self.reverse = true,
                38 | 48 | 58 => match parts.get(i).and_then(|p| p.parse::<u32>().ok()) {
                    Some(5) => i += 2,
                    Some(2) => i += 4,
                    _ => {}
                },
                _ => {}
            }
        }
    }

    /// Samples a W×H module grid from the screen with the given profile.
    pub fn modules(&self, profile: Profile, width: usize, height: usize) -> ModuleGrid {
        let mut grid = ModuleGrid::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let v = match profile {
                    Profile::Ssh => {
                        let cell = self.cell(x, y / 2);
                        // Bottom = cell background; top = glyph if '▀', else background.
                        cell.reverse ^ (y % 2 == 0 && cell.ch == UPPER_HALF)
                    }
                    Profile::Vt100 => self.cell(x, y).reverse,
                };
                grid.set(x, y, v);
            }
        }
        grid
    }

    /// Finds the frame on the screen: tries each profile at the grid size this
    /// screen implies, then at the size the top FI copy declares (a frame drawn
    /// for another size), and returns the first grid whose FI checks out.
    pub fn decode(&self) -> Option<ParsedFrame> {
        [Profile::Ssh, Profile::Vt100].into_iter().find_map(|p| self.decode_as(p))
    }

    fn decode_as(&self, profile: Profile) -> Option<ParsedFrame> {
        let (w, h) = profile.grid_size(self.cols, self.rows);
        let grid = self.modules(profile, w, h);
        if let Some(format) = frame::read_format(&grid).filter(|f| f.profile == profile) {
            return Some(ParsedFrame { format, grid });
        }
        let top = frame::read_format_top(&grid)?;
        let fits = top.width < self.cols && top.height <= self.rows * profile.modules_per_cell();
        if top.profile != profile || !fits || (top.width, top.height) == (w, h) {
            return None;
        }
        let grid = self.modules(profile, top.width, top.height);
        frame::read_format(&grid).filter(|f| *f == top).map(|format| ParsedFrame { format, grid })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Layout;
    use crate::tile::{Codeword, Tile};

    fn sample(profile: Profile, cols: usize, rows: usize) -> (Layout, ModuleGrid) {
        let layout = Layout::for_terminal(profile, cols, rows).unwrap();
        let cws: Vec<Codeword> =
            (0..layout.tiles()).map(|i| Tile::data(7, 0, i as u32, [(i * 37) as u8; 96]).encode()).collect();
        let grid = frame::render(&layout, &cws);
        (layout, grid)
    }

    #[test]
    fn cell_encoding_table() {
        // 2×2 modules → one ssh row with all four (top, bottom) combinations.
        let mut grid = ModuleGrid::new(4, 2);
        for (x, (top, bottom)) in [(false, false), (true, true), (true, false), (false, true)].into_iter().enumerate() {
            grid.set(x, 0, top);
            grid.set(x, 1, bottom);
        }
        let s = frame(&grid, Profile::Ssh, 5, 3, ["", ""], false);
        let row = "\x1b[1;1H \x1b[7m \x1b[m▀\x1b[7m▀\x1b[m";
        assert_eq!(s, format!("\x1b[?2026h{row}\x1b[2;1H    \x1b[3;1H    \x1b[?2026l"));

        let mut grid = ModuleGrid::new(3, 1);
        grid.set(1, 0, true);
        let s = frame(&grid, Profile::Vt100, 4, 3, ["ab", "cdefg"], true);
        assert_eq!(s, "\x1b[2J\x1b[?2026h\x1b[1;1H \x1b[7m \x1b[m \x1b[m\x1b[2;1Hab \x1b[3;1Hcde\x1b[?2026l");
    }

    #[test]
    fn no_color_codes_and_last_column_free() {
        let (_, grid) = sample(Profile::Ssh, 120, 40);
        let s = frame(&grid, Profile::Ssh, 120, 40, ["status", "line"], true);
        for seq in s.split('\x1b').skip(1) {
            let ok = ["[?2026h", "[?2026l", "[2J", "[7m", "[m"].iter().any(|p| seq.starts_with(p))
                || seq.trim_start_matches('[').split_once('H').is_some_and(|(p, _)| p.ends_with(";1"));
            assert!(ok, "unexpected sequence ESC{}", &seq[..seq.len().min(10)]);
        }
        let mut screen = Screen::new(120, 40);
        screen.feed(&s);
        assert!((0..40).all(|y| screen.cell(119, y) == BLANK));
        assert_eq!(screen.line(38).trim_end(), "status");
    }

    #[test]
    fn parse_round_trip_both_profiles() {
        for profile in [Profile::Ssh, Profile::Vt100] {
            for (cols, rows) in [(80, 24), (120, 40), (200, 55)] {
                let Ok(_) = Layout::for_terminal(profile, cols, rows) else { continue };
                let (layout, grid) = sample(profile, cols, rows);
                let s = frame(&grid, profile, cols, rows, ["x", "y"], true);
                let parsed = parse_screen(&s, cols, rows).expect("frame found");
                assert_eq!(parsed.format, layout.format());
                assert_eq!(parsed.grid, grid);
            }
        }
    }

    #[test]
    fn parses_tmux_capture_style_text() {
        let (layout, grid) = sample(Profile::Ssh, 100, 30);
        // capture-pane -e style: no CUP, LF-separated lines, SGR 27 and colors mixed in.
        let raw = frame(&grid, Profile::Ssh, 100, 30, ["s1", "s2"], false);
        let mut screen = Screen::new(100, 30);
        screen.feed(&raw);
        let mut text = String::from("\x1b]0;title\x07");
        for y in 0..30 {
            let mut rev = false;
            for x in 0..100 {
                let c = screen.cell(x, y);
                if c.reverse != rev {
                    text.push_str(if c.reverse { "\x1b[38;5;7;7m" } else { "\x1b[27;39m" });
                    rev = c.reverse;
                }
                text.push(c.ch);
            }
            text.push_str("\x1b[0m\n");
        }
        let parsed = parse_screen(&text, 100, 30).unwrap();
        assert_eq!(parsed.format, layout.format());
        assert_eq!(parsed.grid, grid);
    }

    #[test]
    fn frame_for_other_size_is_found_by_top_fi() {
        let (layout, grid) = sample(Profile::Ssh, 120, 40);
        let s = frame(&grid, Profile::Ssh, 120, 40, ["", ""], true);
        // The terminal grew after the frame was drawn.
        let parsed = parse_screen(&s, 150, 50).unwrap();
        assert_eq!(parsed.format, layout.format());
        assert_eq!(parsed.grid, grid);
    }

    #[test]
    fn sgr_color_arguments_are_not_attributes() {
        let mut screen = Screen::new(10, 2);
        screen.feed("\x1b[38;5;7mA\x1b[48;2;7;7;7mB\x1b[7;38:2::1:2:3mC\x1b[27mD\x1b[7mE\x1b[0mF");
        let rev: Vec<bool> = (0..6).map(|x| screen.cell(x, 0).reverse).collect();
        assert_eq!(rev, [false, false, true, false, true, false]);
    }

    #[test]
    fn empty_or_garbage_screen_has_no_frame() {
        assert_eq!(parse_screen("", 200, 55), None);
        assert_eq!(parse_screen("hello\nworld", 200, 55), None);
        assert_eq!(parse_screen("\x1b[7m", 10, 5), None);
    }
}
