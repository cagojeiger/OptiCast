//! Input validation through the real binary. These never reach the TUI:
//! validation runs first, and stdout here is not a terminal.

use std::path::PathBuf;
use std::process::{Command, Output};

fn opticast(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_opticast")).args(args).output().expect("run opticast")
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("validation");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).expect("UTF-8 stderr")
}

#[test]
fn rejects_directory_with_tar_hint() {
    let dir = scratch("some_dir");
    std::fs::create_dir_all(&dir).unwrap();
    let out = opticast(&["send", dir.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(err.contains("is a directory") && err.contains("tar czf out.tgz"), "{err}");
    assert!(err.is_ascii());
}

#[test]
fn rejects_missing_file() {
    let out = opticast(&["send", scratch("does-not-exist.bin").to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("no such file"), "{}", stderr(&out));
}

#[test]
fn rejects_file_over_max_bytes() {
    let file = scratch("big.bin");
    std::fs::write(&file, vec![0u8; 2048]).unwrap();
    let out = opticast(&["send", file.to_str().unwrap(), "--max-bytes", "1KiB"]);
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(err.contains("2048 bytes") && err.contains("--max-bytes"), "{err}");
}

#[test]
fn rejects_fifo() {
    let fifo = scratch("pipe");
    let _ = std::fs::remove_file(&fifo);
    let made = Command::new("mkfifo").arg(&fifo).status().expect("mkfifo");
    assert!(made.success());
    let out = opticast(&["send", fifo.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("FIFO"), "{}", stderr(&out));
}

#[test]
fn rejects_device() {
    let out = opticast(&["send", "/dev/null"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("device"), "{}", stderr(&out));
}

#[test]
fn follows_symlinks_and_accepts_size_units() {
    let file = scratch("small.txt");
    std::fs::write(&file, b"hello").unwrap();
    let link = scratch("link.txt");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&file, &link).unwrap();
    // Validation passes; it then stops only because stdout is not a terminal.
    let out = opticast(&["send", link.to_str().unwrap(), "--max-bytes", "512KiB"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("not a terminal"), "{}", stderr(&out));
}

#[test]
fn bad_max_bytes_is_a_usage_error() {
    let out = opticast(&["send", "x", "--max-bytes", "lots"]);
    assert_eq!(out.status.code(), Some(2));
}
