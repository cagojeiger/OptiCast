//! Terminal setup and restore. The terminal is restored exactly once on every
//! exit path: normal return (guard drop), signals (main loop sees the flag),
//! and panics (hook).

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;

use crossterm::terminal;
use opticast_core::ansi;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM, SIGWINCH};

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

/// Keyboard input in raw mode, read on its own thread.
pub enum Input {
    Key(u8),
    /// End of input: the terminal is gone (an SSH drop or a killed multiplexer
    /// may send no SIGHUP).
    Closed,
}

/// Reads stdin byte by byte. Escape sequences (arrow keys and the like) are
/// dropped; a lone ESC is passed on.
pub fn spawn_input() -> Receiver<Input> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buf = [0u8; 64];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for &key in keys(&buf[..n]) {
                        if tx.send(Input::Key(key)).is_err() {
                            return;
                        }
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(Input::Closed);
    });
    rx
}

/// The keys in one read: nothing for an escape sequence, else every byte.
fn keys(chunk: &[u8]) -> &[u8] {
    if chunk.len() > 1 && chunk[0] == 0x1b {
        &[]
    } else {
        chunk
    }
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

/// Records the exit code of the last SIGINT/SIGTERM/SIGHUP received (0 = none)
/// and whether the window was resized (SIGWINCH).
pub struct Signals {
    exit: Arc<AtomicUsize>,
    resized: Arc<AtomicBool>,
}

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
        let resized = Arc::new(AtomicBool::new(false));
        signal_hook::flag::register(SIGWINCH, Arc::clone(&resized))?;
        Ok(Signals { exit: flag, resized })
    }

    /// The exit code of a pending signal, if any.
    pub fn pending(&self) -> Option<u8> {
        match self.exit.load(Ordering::SeqCst) {
            0 => None,
            code => Some(code as u8),
        }
    }

    /// True once after each window resize.
    pub fn resized(&self) -> bool {
        self.resized.swap(false, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::keys;

    #[test]
    fn escape_sequences_are_dropped() {
        assert_eq!(keys(b"q"), b"q");
        assert_eq!(keys(b"+-"), b"+-");
        assert_eq!(keys(&[0x1b]), &[0x1b]); // lone ESC quits
        assert!(keys(b"\x1b[A").is_empty()); // arrow up
        assert!(keys(b"\x1b[200~").is_empty());
    }
}
