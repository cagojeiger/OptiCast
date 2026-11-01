//! `opticast`: OptiCast v2 sender. Draws a file as a stream of optical frames
//! in the terminal for a phone camera to receive (`docs/protocol-v2.md`).

mod frames;
mod input;
mod plan;
mod send;
mod status;
mod term;

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};
use opticast_core::Profile;

pub const DEFAULT_FPS: u32 = 24;
pub const DEFAULT_MAX_BYTES: u64 = 64 << 20;

#[derive(Parser)]
#[command(
    name = "opticast",
    version,
    about = "One-way optical file transfer: draw a file as frames for a phone camera"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Broadcast a file in this terminal until you quit
    Send(SendArgs),
    /// Show the frame layout and expected time without sending
    Plan(PlanArgs),
    /// Write consecutive frames' ANSI text to a file (for receiver tests)
    #[command(hide = true)]
    Frames(FramesArgs),
}

#[derive(Args)]
pub struct SendArgs {
    /// The regular file to send (pack directories with tar first)
    pub file: PathBuf,
    /// Frames per second (+/- change it while sending)
    #[arg(long, default_value_t = DEFAULT_FPS, value_parser = clap::value_parser!(u32).range(1..=60))]
    pub fps: u32,
    /// Cell encoding: ssh (half blocks), vt100 (spaces only), or auto
    #[arg(long, value_enum, default_value_t = ProfileArg::Auto)]
    pub profile: ProfileArg,
    /// Refuse files larger than this (e.g. 64MiB, 512KiB)
    #[arg(long, default_value = "64MiB", value_parser = input::parse_size)]
    pub max_bytes: u64,
    /// Do not try deflate
    #[arg(long)]
    pub no_compress: bool,
}

#[derive(Args)]
pub struct PlanArgs {
    /// The file to plan for
    pub file: PathBuf,
    /// Terminal columns to plan for instead of the current terminal
    #[arg(long, requires = "rows", value_parser = clap::value_parser!(u16).range(1..))]
    pub cols: Option<u16>,
    /// Terminal rows to plan for instead of the current terminal
    #[arg(long, requires = "cols", value_parser = clap::value_parser!(u16).range(1..))]
    pub rows: Option<u16>,
}

#[derive(Args)]
pub struct FramesArgs {
    /// The file to encode
    pub file: PathBuf,
    /// Terminal columns
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    pub cols: u16,
    /// Terminal rows
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    pub rows: u16,
    /// Frames to write
    #[arg(long)]
    pub count: u64,
    /// Frames generated and dropped first (a receiver joining mid-stream)
    #[arg(long, default_value_t = 0)]
    pub skip: u64,
    /// Cell encoding (auto is ssh here)
    #[arg(long, value_enum, default_value_t = ProfileArg::Ssh)]
    pub profile: ProfileArg,
    /// First repair ESI offset r0 (the sender picks it at random)
    #[arg(long, default_value_t = 0)]
    pub r0: u32,
    /// Do not try deflate
    #[arg(long)]
    pub no_compress: bool,
    /// Output: JSON lines, a header object then {"index", "ansi"} per frame
    #[arg(long)]
    pub out: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ProfileArg {
    Auto,
    Ssh,
    Vt100,
}

/// Picks the profile (spec §2). `auto` is `ssh` unless we run under tmux or
/// screen with a non-UTF-8 locale, where `▀` would be mangled; then `vt100`
/// with a warning.
fn resolve_profile(arg: ProfileArg, env: impl Fn(&str) -> Option<String>) -> (Profile, Option<String>) {
    match arg {
        ProfileArg::Ssh => (Profile::Ssh, None),
        ProfileArg::Vt100 => (Profile::Vt100, None),
        ProfileArg::Auto => {
            let multiplexer = env("TMUX").is_some() || env("STY").is_some();
            let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
                .iter()
                .find_map(|k| env(k).filter(|v| !v.is_empty()))
                .unwrap_or_default();
            let lower = locale.to_ascii_lowercase();
            let utf8 = lower.contains("utf-8") || lower.contains("utf8");
            if multiplexer && !utf8 {
                let shown = if locale.is_empty() { "unset".into() } else { status::ascii(&locale) };
                let warning = format!(
                    "warning: tmux/screen with a non-UTF-8 locale ({shown}) may mangle half blocks; \
                     using the vt100 profile (half the density). Set a UTF-8 locale or pass --profile ssh."
                );
                (Profile::Vt100, Some(warning))
            } else {
                (Profile::Ssh, None)
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let env = |k: &str| std::env::var(k).ok();
    let result = match &cli.command {
        Command::Send(args) => {
            let (profile, warning) = resolve_profile(args.profile, env);
            if let Some(w) = warning {
                let _ = writeln!(io::stderr(), "{w}");
            }
            send::run(args, profile)
        }
        Command::Plan(args) => plan::run(args, resolve_profile(ProfileArg::Auto, env).0).map(|()| 0),
        Command::Frames(args) => frames::run(args).map(|()| 0),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            let _ = writeln!(io::stderr(), "opticast: error: {message}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| vars.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn auto_profile() {
        let auto = |vars| resolve_profile(ProfileArg::Auto, env_of(vars)).0;
        assert_eq!(auto(&[("LANG", "C")]), Profile::Ssh);
        assert_eq!(auto(&[("TMUX", "/tmp/x"), ("LANG", "ko_KR.UTF-8")]), Profile::Ssh);
        assert_eq!(auto(&[("TMUX", "/tmp/x"), ("LANG", "en_US.utf8")]), Profile::Ssh);
        assert_eq!(auto(&[("TMUX", "/tmp/x"), ("LANG", "C")]), Profile::Vt100);
        assert_eq!(auto(&[("STY", "1.pts"), ("LANG", "en_US.UTF-8"), ("LC_ALL", "C")]), Profile::Vt100);
        assert_eq!(auto(&[("STY", "1.pts"), ("LC_ALL", ""), ("LC_CTYPE", "UTF-8")]), Profile::Ssh);
        assert_eq!(auto(&[("TMUX", "/tmp/x")]), Profile::Vt100);
        let (_, warning) = resolve_profile(ProfileArg::Auto, env_of(&[("TMUX", "x")]));
        assert!(warning.is_some_and(|w| w.is_ascii() && w.contains("vt100")));
        assert_eq!(resolve_profile(ProfileArg::Ssh, env_of(&[("TMUX", "x")])).0, Profile::Ssh);
    }

    #[test]
    fn cli_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
