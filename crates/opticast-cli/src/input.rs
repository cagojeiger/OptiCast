//! Input validation (spec §1): one regular file, at most `--max-bytes`.

use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

use crate::status::ascii;

/// A validated input file.
pub struct Input {
    pub data: Vec<u8>,
    /// Base name of the path as given (a symlink keeps its own name).
    pub name: String,
}

/// Reads `path` if it is a regular file (symlinks followed) of at most `max_bytes`.
pub fn load(path: &Path, max_bytes: u64) -> Result<Input, String> {
    let shown = ascii(&path.display().to_string());
    // stat first: opening a FIFO would block until a writer appears.
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("{shown}: no such file"),
        _ => format!("{shown}: cannot access: {}", ascii(&e.to_string())),
    })?;
    let kind = meta.file_type();
    if kind.is_dir() {
        let dir = shown.trim_end_matches('/');
        return Err(format!(
            "{shown} is a directory; send a single file, e.g. pack it with `tar czf out.tgz {dir}/` and send out.tgz"
        ));
    }
    if !kind.is_file() {
        let what = if kind.is_fifo() {
            "a FIFO"
        } else if kind.is_block_device() || kind.is_char_device() {
            "a device"
        } else if kind.is_socket() {
            "a socket"
        } else {
            "not a regular file"
        };
        return Err(format!("{shown} is {what}; only regular files can be sent"));
    }
    let too_large =
        |size: u64| format!("{shown} is {size} bytes, over the limit of {max_bytes} bytes (raise it with --max-bytes)");
    if meta.len() > max_bytes {
        return Err(too_large(meta.len()));
    }

    let read_err = |e: io::Error| format!("{shown}: cannot read: {}", ascii(&e.to_string()));
    let file = File::open(path).map_err(read_err)?;
    // Re-check on the open handle in case the path changed in between.
    if !file.metadata().map_err(read_err)?.is_file() {
        return Err(format!("{shown} is not a regular file"));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut data).map_err(read_err)?;
    if data.len() as u64 > max_bytes {
        return Err(too_large(data.len() as u64));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    Ok(Input { data, name })
}

/// Parses a byte size: `1048576`, `512KiB`, `64MiB`, `1GiB`, `10MB`, `1k`.
/// Binary suffixes (K, KiB, M, MiB, G, GiB) are powers of 1024; KB, MB, GB are powers of 1000.
pub fn parse_size(text: &str) -> Result<u64, String> {
    let t = text.trim();
    let split = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let n: u64 = num.parse().map_err(|_| format!("invalid size `{}`", ascii(text)))?;
    let mult: u64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kib" => 1 << 10,
        "m" | "mib" => 1 << 20,
        "g" | "gib" => 1 << 30,
        "kb" => 1_000,
        "mb" => 1_000_000,
        "gb" => 1_000_000_000,
        _ => return Err(format!("invalid size `{}` (use e.g. 512KiB, 64MiB, 1GiB)", ascii(text))),
    };
    n.checked_mul(mult).ok_or_else(|| format!("size `{}` is too large", ascii(text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(parse_size("64MiB"), Ok(64 << 20));
        assert_eq!(parse_size("512KiB"), Ok(512 << 10));
        assert_eq!(parse_size("1gib"), Ok(1 << 30));
        assert_eq!(parse_size("10MB"), Ok(10_000_000));
        assert_eq!(parse_size("1000"), Ok(1000));
        assert_eq!(parse_size("2k"), Ok(2048));
        assert_eq!(parse_size(" 3 MiB "), Ok(3 << 20));
        assert!(parse_size("").is_err());
        assert!(parse_size("MiB").is_err());
        assert!(parse_size("5 parsecs").is_err());
        assert!(parse_size("-1").is_err());
        assert!(parse_size("99999999999999GiB").is_err());
    }
}
