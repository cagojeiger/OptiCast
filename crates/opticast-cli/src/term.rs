//! Terminal setup and restore. The terminal is restored exactly once on every
//! exit path: normal return (guard drop), signals (main loop sees the flag),
//! and panics (hook).

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use crossterm::terminal;
use opticast_core::ansi;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};

/// True while the terminal is in raw mode on the alternate screen.
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Raw mode + alternate screen for as long as the guard lives.
pub struct TerminalGuard(());

impl TerminalGuard {
    pub fn enter() -> io::Result<TerminalGuard> {
        terminal::enable_raw_mode()?;
        ACTIVE.store(true, Ordering::SeqCst);
        let guard = TerminalGuard(());
        write_all(ansi::ENTER)?;
        Ok(guard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

/// Leaves the alternate screen and raw mode if still active. Errors are
/// ignored: after a hangup there may be no terminal left to write to.
pub fn restore() {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = write_all(ansi::LEAVE);
        let _ = terminal::disable_raw_mode();
    }
}

/// Restores the terminal before the default panic message is printed.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        default(info);
    }));
}

/// One locked write of the exact bytes, then flush.
pub fn write_all(text: &str) -> io::Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(text.as_bytes())?;
    out.flush()
}

/// Exit codes for the signals we handle: 128 + signal number.
pub const EXIT_SIGINT: u8 = 130;
pub const EXIT_SIGTERM: u8 = 143;
pub const EXIT_SIGHUP: u8 = 129;

/// Records the exit code of the last SIGINT/SIGTERM/SIGHUP received (0 = none).
pub struct Signals(Arc<AtomicUsize>);

impl Signals {
    /// The first signal sets the flag for the main loop. Handlers use SA_RESTART,
    /// so a write blocked on a stalled tty never returns to see it; a second
    /// SIGTERM/SIGHUP therefore exits immediately.
    pub fn register() -> io::Result<Signals> {
        let flag = Arc::new(AtomicUsize::new(0));
        let armed = Arc::new(AtomicBool::new(false));
        for (signal, code) in [(SIGINT, EXIT_SIGINT), (SIGTERM, EXIT_SIGTERM), (SIGHUP, EXIT_SIGHUP)] {
            if signal != SIGINT {
                signal_hook::flag::register_conditional_shutdown(signal, code as i32, Arc::clone(&armed))?;
                signal_hook::flag::register(signal, Arc::clone(&armed))?;
            }
            signal_hook::flag::register_usize(signal, Arc::clone(&flag), code as usize)?;
        }
        Ok(Signals(flag))
    }

    /// The exit code of a pending signal, if any.
    pub fn pending(&self) -> Option<u8> {
        match self.0.load(Ordering::SeqCst) {
            0 => None,
            code => Some(code as u8),
        }
    }
}
