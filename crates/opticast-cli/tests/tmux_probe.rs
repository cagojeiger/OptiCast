//! Manual real-terminal probe: runs the built `opticast send` in a tmux pane on
//! a private socket, captures the pane with `capture-pane -p -e -N`, decodes
//! the captures until the file is restored, then quits with `q`.
//!
//!   cargo test -p opticast-cli --test tmux_probe -- --ignored --nocapture

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use opticast_core::{ansi, frame, Assembler, Layout};

const SOCKET: &str = "opticast-probe";
const SESSION: &str = "probe";

fn tmux(args: &[&str]) -> String {
    let out = Command::new("tmux")
        .args(["-u", "-L", SOCKET, "-f", "/dev/null"])
        .args(args)
        .env("LC_ALL", "en_US.UTF-8")
        .output()
        .expect("run tmux");
    assert!(out.status.success(), "tmux {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("UTF-8 capture")
}

fn pane(format: &str) -> String {
    tmux(&["display", "-p", "-t", SESSION, format]).trim().to_string()
}

fn pane_size() -> (usize, usize) {
    let size = pane("#{pane_width} #{pane_height}");
    let (w, h) = size.split_once(' ').expect("two numbers");
    (w.parse().unwrap(), h.parse().unwrap())
}

/// Forces the window to W×H; the user's tmux may default to `window-size latest`.
fn resize(w: usize, h: usize) {
    let (w, h) = (w.to_string(), h.to_string());
    tmux(&[
        "set-option",
        "-w",
        "-t",
        SESSION,
        "window-size",
        "manual",
        ";",
        "resize-window",
        "-t",
        SESSION,
        "-x",
        &w,
        "-y",
        &h,
    ]);
}

struct Server;

impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("tmux").args(["-L", SOCKET, "kill-server"]).output();
    }
}

#[test]
#[ignore = "needs tmux; run manually"]
fn tmux_probe() {
    let _ = Command::new("tmux").args(["-L", SOCKET, "kill-server"]).output();
    let file = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("probe.bin");
    let mut s = 0x2545_F491_4F6C_DD1Du64;
    let data: Vec<u8> = (0..40_000)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s as u8
        })
        .collect();
    std::fs::write(&file, &data).unwrap();

    // A shell stays behind after the sender exits so its last output (the
    // summary) is not lost when the pty closes, and it reports the exit code.
    let command =
        format!("'{}' send '{}'; echo \"opticast-exit=$?\"; sleep 30", env!("CARGO_BIN_EXE_opticast"), file.display());
    let _server = Server;
    tmux(&["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40", &command]);
    resize(120, 40);
    assert_eq!(pane_size(), (120, 40), "pane size not forced");
    println!("pane      120x40");

    let mut rx = Assembler::new();
    let (mut captures, mut framed, mut ok, mut rejected) = (0, 0, 0, 0);
    let mut resized = false;
    let mut formats = Vec::new();
    let mut status = String::new();
    let start = Instant::now();
    while !rx.is_complete() && start.elapsed() < Duration::from_secs(60) {
        // Halfway through, change the terminal size under the running sender.
        if !resized && start.elapsed() > Duration::from_millis(1500) {
            resize(100, 30);
            resized = true;
        }
        let (cols, rows) = pane_size();
        let text = tmux(&["capture-pane", "-p", "-e", "-N", "-t", SESSION]);
        captures += 1;
        let mut screen = ansi::Screen::new(cols, rows);
        screen.feed(&text);
        status = screen.line(rows - 1).trim_end().to_string();
        let Some(parsed) = screen.decode() else { continue };
        framed += 1;
        if !formats.contains(&parsed.format) {
            formats.push(parsed.format);
        }
        let Ok(layout) = Layout::from_format(parsed.format) else { continue };
        for result in frame::decode_tiles(&layout, &parsed.grid) {
            match result {
                Ok(t) => {
                    ok += 1;
                    rx.accept(&t);
                }
                Err(_) => rejected += 1,
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    println!(
        "captures  {captures} ({framed} with a frame), tiles ok {ok}, rejected {rejected}, {:.1}s",
        start.elapsed().as_secs_f64()
    );
    for f in &formats {
        println!("layout    {} {}x{}", f.profile, f.width, f.height);
    }
    println!("status    {status}");
    assert!(rx.is_complete(), "not restored: {:?}", rx.stats());
    let restored = rx.finalize().expect("size and SHA-256 verified");
    assert_eq!(restored, data);
    println!("restored  {} bytes, transfer {:08x}, byte-identical", restored.len(), rx.transfer_id().unwrap());
    assert!(formats.len() >= 2, "resize should change the layout");

    tmux(&["send-keys", "-t", SESSION, "q"]);
    let deadline = Instant::now() + Duration::from_secs(10);
    let after = loop {
        let text = tmux(&["capture-pane", "-p", "-t", SESSION]);
        if text.contains("opticast-exit=") {
            break text;
        }
        assert!(Instant::now() < deadline, "sender did not exit after q");
        std::thread::sleep(Duration::from_millis(50));
    };
    let line = |prefix: &str| after.lines().find(|l| l.starts_with(prefix)).unwrap_or_default().to_string();
    let code = line("opticast-exit=");
    let summary = line("opticast:");
    let alternate = pane("#{alternate_on}");
    println!("after q   {code}, alternate screen {alternate}, summary: {summary}");
    assert_eq!(code, "opticast-exit=0");
    assert_eq!(alternate, "0", "terminal not restored");
    assert!(summary.contains("(quit)"), "{after}");
}
