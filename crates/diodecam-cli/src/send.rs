//! `diodecam send`: the frame loop.

use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::BuildHasher;
use std::io::{self, IsTerminal, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use crossterm::terminal;
use diodecam_core::layout::{min_rows, MIN_WIDTH};
use diodecam_core::sender::R0_RANGE;
use diodecam_core::{ansi, frame, FormatInfo, Layout, ModuleGrid, Profile, SendOptions, TooSmall, Transfer};

use crate::args::SendArgs;
use crate::file;
use crate::status::{self, ascii, clock, thousands, Status};
use crate::term::{self, Input, Signals, TerminalGuard, EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM};

/// `+`/`-` move between these rates.
pub const FPS_STEPS: [u32; 10] = [2, 3, 5, 8, 10, 12, 15, 20, 24, 30];

/// How the frame loop ended, and the process exit code for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Exit {
    Quit,
    Signal(u8),
}

impl Exit {
    fn code(self) -> u8 {
        match self {
            Exit::Quit => 0,
            Exit::Signal(code) => code,
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Exit::Quit => "quit",
            Exit::Signal(EXIT_SIGINT) => "interrupted",
            Exit::Signal(EXIT_SIGTERM) => "terminated",
            Exit::Signal(EXIT_SIGHUP) => "hangup",
            Exit::Signal(_) => "signal",
        }
    }
}

pub fn run(args: &SendArgs, profile: Profile) -> Result<u8, String> {
    let input = file::load(&args.file, args.max_bytes)?;
    if !io::stdout().is_terminal() {
        return Err("send draws on the terminal, but stdout is not a terminal".into());
    }
    let r0 = (RandomState::new().hash_one(std::process::id()) % R0_RANGE as u64) as u32;
    let mut transfer = Transfer::prepare(&input.data, &input.name, SendOptions { compress: !args.no_compress }, r0)
        .map_err(|e| e.to_string())?;
    drop(input.data);
    transfer.prepare_repair();
    if args.fps == 30 {
        let _ = writeln!(io::stderr(), "hint: {PHASE_LOCK_NOTICE}");
    }

    let signals = Signals::register().map_err(|e| format!("cannot install signal handlers: {e}"))?;
    let (cols, rows) = terminal::size().map_err(|e| format!("cannot read the terminal size: {e}"))?;
    term::install_panic_hook();
    let guard = TerminalGuard::enter().map_err(|e| format!("cannot set up the terminal: {e}"))?;
    let keys = term::spawn_input();
    let mut sender = Sender::new(transfer, input.name, profile, args.fps, cols as usize, rows as usize);
    let result = sender.run(&signals, &keys);
    drop(guard);

    let exit = match result {
        Ok(exit) => exit,
        // A write error after SIGHUP/SIGTERM is expected; report the signal instead.
        Err(e) => match signals.pending() {
            Some(code) => Exit::Signal(code),
            None => return Err(format!("terminal I/O failed: {e}")),
        },
    };
    let t = &sender.transfer;
    let _ = writeln!(
        io::stdout(),
        "diodecam: {} id {:08x}: {} frames in {}, source {:.0}%, +repair {} ({})",
        ascii(&sender.name),
        t.id(),
        thousands(t.frames_sent()),
        clock(sender.started.elapsed()),
        (t.source_progress() * 100.0).floor().min(100.0),
        thousands(t.repair_sent()),
        exit.reason()
    );
    Ok(exit.code())
}

enum KeyAction {
    Exit(Exit),
    Changed,
    Ignored,
}

const PHASE_LOCK_NOTICE: &str = "30 fps may phase-lock with a 30 fps camera; 24 is safer";

/// The 30-fps hint stays in the status bar this long after 30 fps is chosen.
fn phase_lock_notice(fps: u32) -> Option<Instant> {
    (fps == 30).then(|| Instant::now() + Duration::from_secs(6))
}

/// What is currently on screen, to decide when to clear it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Drawn {
    Nothing,
    Grid(FormatInfo, usize, usize),
    Message(usize, usize),
}

struct Sender {
    transfer: Transfer,
    name: String,
    profile: Profile,
    fps: u32,
    paused: bool,
    cols: usize,
    rows: usize,
    layout: Result<Layout, TooSmall>,
    drawn: Drawn,
    /// The last grid drawn, repainted while paused.
    grid: Option<ModuleGrid>,
    meter: FpsMeter,
    started: Instant,
    notice_until: Option<Instant>,
}

impl Sender {
    fn new(transfer: Transfer, name: String, profile: Profile, fps: u32, cols: usize, rows: usize) -> Sender {
        Sender {
            transfer,
            name,
            profile,
            fps,
            paused: false,
            cols,
            rows,
            layout: Layout::for_terminal(profile, cols, rows),
            drawn: Drawn::Nothing,
            grid: None,
            meter: FpsMeter::default(),
            started: Instant::now(),
            notice_until: phase_lock_notice(fps),
        }
    }

    fn run(&mut self, signals: &Signals, keys: &Receiver<Input>) -> io::Result<Exit> {
        let mut next_due = Instant::now();
        loop {
            if let Some(code) = signals.pending() {
                return Ok(Exit::Signal(code));
            }
            if signals.resized() {
                let (cols, rows) = terminal::size()?;
                self.resize(cols as usize, rows as usize);
                next_due = Instant::now();
            }
            if Instant::now() >= next_due {
                let streaming = !self.paused && self.layout.is_ok();
                self.draw(streaming)?;
                let now = Instant::now();
                next_due = if streaming {
                    // Keep a steady cadence; if writes fall behind, do not burst to catch up.
                    (next_due + Duration::from_secs_f64(1.0 / self.fps as f64)).max(now)
                } else {
                    now + Duration::from_millis(500) // idle: just refresh the status bar
                };
            }
            // Short waits keep signal handling responsive.
            let wait = next_due.saturating_duration_since(Instant::now()).min(Duration::from_millis(100));
            match keys.recv_timeout(wait) {
                Ok(Input::Key(key)) => match self.key(key) {
                    KeyAction::Exit(exit) => return Ok(exit),
                    // Repaint the current grid with the new status bar; only the timer
                    // decides when the transfer advances, so typing cannot flood the link.
                    KeyAction::Changed => {
                        self.draw(false)?;
                        let period = Duration::from_secs_f64(1.0 / self.fps as f64);
                        next_due = if self.paused { Instant::now() } else { next_due.min(Instant::now() + period) };
                    }
                    KeyAction::Ignored => {}
                },
                Err(RecvTimeoutError::Timeout) => {}
                // The terminal is gone, whether or not a SIGHUP came with it.
                Ok(Input::Closed) | Err(RecvTimeoutError::Disconnected) => return Ok(Exit::Signal(EXIT_SIGHUP)),
            }
        }
    }

    fn key(&mut self, key: u8) -> KeyAction {
        match key {
            0x03 => KeyAction::Exit(Exit::Signal(EXIT_SIGINT)), // Ctrl-C in raw mode
            b'q' | 0x1b => KeyAction::Exit(Exit::Quit),
            b'+' => self.set_fps(FPS_STEPS.iter().copied().find(|&s| s > self.fps)),
            b'-' => self.set_fps(FPS_STEPS.iter().rev().copied().find(|&s| s < self.fps)),
            b' ' => {
                self.paused = !self.paused;
                self.meter.reset();
                KeyAction::Changed
            }
            _ => KeyAction::Ignored,
        }
    }

    fn set_fps(&mut self, step: Option<u32>) -> KeyAction {
        let Some(fps) = step else { return KeyAction::Ignored };
        self.fps = fps;
        self.meter.reset();
        self.notice_until = phase_lock_notice(fps);
        KeyAction::Changed
    }

    fn resize(&mut self, cols: usize, rows: usize) {
        self.cols = cols;
        self.rows = rows;
        self.layout = Layout::for_terminal(self.profile, cols, rows);
        self.meter.reset(); // frame cost changes with the size; measure afresh
    }

    /// Draws one frame. `advance` takes the next tiles from the transfer;
    /// otherwise the last grid is repainted with a fresh status bar.
    fn draw(&mut self, advance: bool) -> io::Result<()> {
        let (cols, rows) = (self.cols, self.rows);
        let layout = match &self.layout {
            Ok(layout) => layout,
            Err(_) => {
                let lines = self.too_small_message();
                let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
                let status = status::lines(&self.status(), cols);
                let clear = self.drawn != Drawn::Message(cols, rows);
                term::write_all(&ansi::message_frame(&refs, cols, rows, [&status[0], &status[1]], clear))?;
                self.drawn = Drawn::Message(cols, rows);
                self.grid = None;
                return Ok(());
            }
        };
        let here = Drawn::Grid(layout.format(), cols, rows);
        // A new layout always needs new tiles, even while paused.
        let fresh = advance || self.drawn != here || self.grid.is_none();
        if fresh {
            let codewords = self.transfer.next_frame(layout);
            self.grid = Some(frame::render(layout, &codewords));
        }
        let status = status::lines(&self.status(), cols);
        let Some(grid) = &self.grid else { return Ok(()) };
        // Clear on any layout or terminal size change so no stale rows remain.
        let text = ansi::frame(grid, self.profile, cols, rows, [&status[0], &status[1]], self.drawn != here);
        term::write_all(&text)?;
        if fresh {
            self.meter.record(Instant::now());
        }
        self.drawn = here;
        Ok(())
    }

    fn status(&self) -> Status<'_> {
        Status {
            elapsed: self.started.elapsed(),
            actual_fps: self.meter.fps(),
            paused: self.paused,
            notice: self.notice_until.filter(|&t| Instant::now() < t).map(|_| PHASE_LOCK_NOTICE),
            ..Status::for_transfer(&self.transfer, self.profile, self.layout.as_ref().ok(), self.fps)
        }
    }

    fn too_small_message(&self) -> Vec<String> {
        let cols = self.cols.max(MIN_WIDTH + 1);
        let need = match min_rows(self.profile, cols) {
            Some(rows) => format!("{cols}x{rows}"),
            None => format!("{} columns", MIN_WIDTH + 1),
        };
        vec![
            String::new(),
            format!(" Terminal too small for DiodeCam ({} profile): {}x{}.", self.profile, self.cols, self.rows),
            format!(" Minimum size: {need}. Enlarge the window or use a smaller font."),
            " [q] quit".into(),
        ]
    }
}

/// Measures frames actually written per second over the last two seconds.
#[derive(Default)]
struct FpsMeter {
    times: VecDeque<Instant>,
}

impl FpsMeter {
    const WINDOW: Duration = Duration::from_secs(2);

    /// Keeps the newest sample that is at least `WINDOW` old as an anchor, so
    /// frames more than `WINDOW` apart (a very slow link) still measure a rate.
    fn record(&mut self, t: Instant) {
        self.times.push_back(t);
        while self.times.len() > 2 && t.duration_since(self.times[1]) >= Self::WINDOW {
            self.times.pop_front();
        }
    }

    fn reset(&mut self) {
        self.times.clear();
    }

    /// `None` until at least half a second of frames has been seen.
    fn fps(&self) -> Option<f64> {
        let (first, last) = (self.times.front()?, self.times.back()?);
        let span = last.duration_since(*first).as_secs_f64();
        (span >= 0.5).then(|| (self.times.len() - 1) as f64 / span)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fps_meter() {
        let mut m = FpsMeter::default();
        let t0 = Instant::now();
        assert_eq!(m.fps(), None);
        for i in 0..=30 {
            m.record(t0 + Duration::from_millis(100 * i));
        }
        // 2-second window of 10 fps.
        assert!((m.fps().unwrap() - 10.0).abs() < 1e-6);
        m.reset();
        assert_eq!(m.fps(), None);
        // Frames 3 s apart: still measured, not reported as the target rate.
        m.record(t0);
        m.record(t0 + Duration::from_secs(3));
        m.record(t0 + Duration::from_secs(6));
        assert!((m.fps().unwrap() - 1.0 / 3.0).abs() < 1e-6);
    }

    #[test]
    fn exit_codes() {
        assert_eq!(Exit::Quit.code(), 0);
        assert_eq!(Exit::Signal(EXIT_SIGINT).code(), 130);
        assert_eq!(Exit::Signal(EXIT_SIGTERM).code(), 143);
        assert_eq!(Exit::Signal(EXIT_SIGHUP).code(), 129);
    }
}
