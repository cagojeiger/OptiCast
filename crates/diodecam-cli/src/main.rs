//! `diodecam`: DiodeCam sender. Draws a file as a stream of optical frames
//! in the terminal for a phone camera to receive (`docs/protocol.md`).

mod frames;
mod input;
mod send;
mod status;
mod term;

use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use diodecam_core::Profile;

pub const DEFAULT_FPS: u32 = 24;
pub const DEFAULT_MAX_BYTES: u64 = 64 << 20;

const USAGE: &str = "\
One-way optical file transfer: draw a file as frames for a phone camera

Usage: diodecam send <FILE> [OPTIONS]

Options:
      --fps <N>           Frames per second, 1-60 [default: 24]
      --profile <P>       auto, ssh (half blocks) or vt100 (spaces only) [default: auto]
      --max-bytes <SIZE>  Refuse larger files, e.g. 512KiB, 64MiB [default: 64MiB]
      --no-compress       Do not try deflate
  -h, --help              Print help
  -V, --version           Print version

Keys while sending: + / - fps, space pause, q quit. Pack directories with tar first.
";

pub struct SendArgs {
    pub file: PathBuf,
    pub fps: u32,
    pub profile: ProfileArg,
    pub max_bytes: u64,
    pub no_compress: bool,
}

/// `diodecam frames` (hidden): consecutive frames' ANSI text, for receiver tests.
pub struct FramesArgs {
    pub file: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub count: u64,
    /// Frames generated and dropped first (a receiver joining mid-stream).
    pub skip: u64,
    pub profile: ProfileArg,
    /// First repair ESI offset r0 (`send` picks it at random).
    pub r0: u32,
    pub no_compress: bool,
    /// JSON lines: a header object, then {"index", "ansi"} per frame.
    pub out: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileArg {
    Auto,
    Ssh,
    Vt100,
}

enum Command {
    Send(SendArgs),
    Frames(FramesArgs),
    Print(String),
}

/// One subcommand's arguments: positional values and `--name value` /
/// `--name=value` / bare `--flag` options (the last one wins).
struct Opts {
    positional: Vec<PathBuf>,
    options: Vec<(String, Option<String>)>,
}

impl Opts {
    fn parse(mut args: impl Iterator<Item = OsString>, valued: &[&str], flags: &[&str]) -> Result<Opts, String> {
        let mut opts = Opts { positional: Vec::new(), options: Vec::new() };
        while let Some(arg) = args.next() {
            let text = arg.to_string_lossy().into_owned();
            let Some(option) = text.strip_prefix("--") else {
                opts.positional.push(PathBuf::from(arg));
                continue;
            };
            let (name, inline) = match option.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (option, None),
            };
            let value = if valued.contains(&name) {
                match inline {
                    Some(value) => Some(value),
                    None => Some(args.next().ok_or(format!("--{name} needs a value"))?.to_string_lossy().into_owned()),
                }
            } else if flags.contains(&name) && inline.is_none() {
                None
            } else {
                return Err(format!("unknown option `--{}`", status::ascii(name)));
            };
            opts.options.push((name.to_string(), value));
        }
        Ok(opts)
    }

    fn file(&self) -> Result<PathBuf, String> {
        match self.positional.as_slice() {
            [file] => Ok(file.clone()),
            [] => Err("missing <FILE>".into()),
            _ => Err("expected one <FILE>".into()),
        }
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.options.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    fn flag(&self, name: &str) -> bool {
        self.options.iter().any(|(n, _)| n == name)
    }

    fn number<T: std::str::FromStr + PartialOrd + std::fmt::Display>(
        &self,
        name: &str,
        default: Option<T>,
        range: std::ops::RangeInclusive<T>,
    ) -> Result<T, String> {
        let value = match (self.value(name), default) {
            (Some(text), _) => text.parse().map_err(|_| format!("invalid --{name} `{}`", status::ascii(text)))?,
            (None, Some(default)) => default,
            (None, None) => return Err(format!("missing --{name}")),
        };
        if !range.contains(&value) {
            return Err(format!("--{name} must be {}..={}", range.start(), range.end()));
        }
        Ok(value)
    }

    fn profile(&self, default: ProfileArg) -> Result<ProfileArg, String> {
        match self.value("profile") {
            None => Ok(default),
            Some("auto") => Ok(ProfileArg::Auto),
            Some("ssh") => Ok(ProfileArg::Ssh),
            Some("vt100") => Ok(ProfileArg::Vt100),
            Some(other) => Err(format!("invalid --profile `{}` (auto, ssh or vt100)", status::ascii(other))),
        }
    }
}

fn parse(args: Vec<OsString>) -> Result<Command, String> {
    let help = |a: &OsString| a == "-h" || a == "--help" || a == "help";
    if args.is_empty() || args.iter().any(help) {
        return Ok(Command::Print(USAGE.into()));
    }
    if args.iter().any(|a| a == "-V" || a == "--version") {
        return Ok(Command::Print(format!("diodecam {}\n", env!("CARGO_PKG_VERSION"))));
    }
    let mut args = args.into_iter();
    let command = args.next().unwrap_or_default();
    match command.to_string_lossy().as_ref() {
        "send" => {
            let opts = Opts::parse(args, &["fps", "profile", "max-bytes"], &["no-compress"])?;
            Ok(Command::Send(SendArgs {
                file: opts.file()?,
                fps: opts.number("fps", Some(DEFAULT_FPS), 1..=60)?,
                profile: opts.profile(ProfileArg::Auto)?,
                max_bytes: opts.value("max-bytes").map_or(Ok(DEFAULT_MAX_BYTES), input::parse_size)?,
                no_compress: opts.flag("no-compress"),
            }))
        }
        "frames" => {
            let valued = ["cols", "rows", "count", "skip", "profile", "r0", "out"];
            let opts = Opts::parse(args, &valued, &["no-compress"])?;
            Ok(Command::Frames(FramesArgs {
                file: opts.file()?,
                cols: opts.number("cols", None, 1..=u16::MAX)?,
                rows: opts.number("rows", None, 1..=u16::MAX)?,
                count: opts.number("count", None, 0..=u64::MAX)?,
                skip: opts.number("skip", Some(0), 0..=u64::MAX)?,
                profile: opts.profile(ProfileArg::Ssh)?,
                r0: opts.number("r0", Some(0), 0..=u32::MAX)?,
                no_compress: opts.flag("no-compress"),
                out: PathBuf::from(opts.value("out").ok_or("missing --out")?),
            }))
        }
        other => Err(format!("unknown command `{}`", status::ascii(other))),
    }
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
    let command = match parse(std::env::args_os().skip(1).collect()) {
        Ok(command) => command,
        Err(message) => {
            let _ = writeln!(io::stderr(), "diodecam: error: {message}\nRun `diodecam --help` for usage.");
            return ExitCode::from(2);
        }
    };
    let result = match &command {
        Command::Print(text) => io::stdout().write_all(text.as_bytes()).map(|()| 0).map_err(|e| e.to_string()),
        Command::Send(args) => {
            let (profile, warning) = resolve_profile(args.profile, |k| std::env::var(k).ok());
            if let Some(w) = warning {
                let _ = writeln!(io::stderr(), "{w}");
            }
            send::run(args, profile)
        }
        Command::Frames(args) => frames::run(args).map(|()| 0),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            let _ = writeln!(io::stderr(), "diodecam: error: {message}");
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

    fn args(line: &str) -> Vec<OsString> {
        line.split_whitespace().map(OsString::from).collect()
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
    fn send_arguments() {
        let Ok(Command::Send(a)) = parse(args("send f.bin")) else { panic!("send f.bin") };
        assert_eq!(a.file, PathBuf::from("f.bin"));
        assert_eq!((a.fps, a.profile, a.max_bytes, a.no_compress), (24, ProfileArg::Auto, 64 << 20, false));
        let line = "send --fps=15 f.bin --profile vt100 --max-bytes 1KiB --no-compress";
        let Ok(Command::Send(a)) = parse(args(line)) else { panic!("{line}") };
        assert_eq!((a.fps, a.profile, a.max_bytes, a.no_compress), (15, ProfileArg::Vt100, 1024, true));
        for bad in [
            "send",
            "send a b",
            "send f --fps 0",
            "send f --fps x",
            "send f --fps",
            "send f --nope",
            "send f --profile x",
        ] {
            assert!(parse(args(bad)).is_err(), "{bad}");
        }
        assert!(parse(args("nope f")).is_err());
    }

    #[test]
    fn frames_arguments() {
        let line = "frames f --cols 200 --rows 55 --count 3 --out o.jsonl --skip 7";
        let Ok(Command::Frames(a)) = parse(args(line)) else { panic!("{line}") };
        assert_eq!((a.cols, a.rows, a.count, a.skip, a.r0, a.profile), (200, 55, 3, 7, 0, ProfileArg::Ssh));
        assert!(parse(args("frames f --cols 200 --rows 55 --count 3")).is_err(), "--out is required");
    }

    #[test]
    fn help_and_version() {
        for line in ["", "--help", "send -h", "help"] {
            assert!(matches!(parse(args(line)), Ok(Command::Print(t)) if t.contains("Usage")), "{line}");
        }
        assert!(matches!(parse(args("-V")), Ok(Command::Print(t)) if t.starts_with("diodecam ")));
    }
}
