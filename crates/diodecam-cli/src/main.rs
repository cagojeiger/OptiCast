//! `diodecam`: DiodeCam sender. Draws a file as a stream of optical frames
//! in the terminal for a phone camera to receive (`docs/cli.md`).

mod args;
mod file;
mod frames;
mod send;
mod status;
mod term;

use std::io::{self, Write};
use std::process::ExitCode;

use args::Command;

fn main() -> ExitCode {
    let command = match args::parse(std::env::args_os().skip(1).collect()) {
        Ok(command) => command,
        Err(message) => {
            let _ = writeln!(io::stderr(), "diodecam: error: {message}\nRun `diodecam --help` for usage.");
            return ExitCode::from(2);
        }
    };
    let result = match &command {
        Command::Print(text) => io::stdout().write_all(text.as_bytes()).map(|()| 0).map_err(|e| e.to_string()),
        Command::Send(args) => {
            let (profile, warning) = args::resolve_profile(args.profile, |k| std::env::var(k).ok());
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
