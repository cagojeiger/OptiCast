//! The 96-byte META block (spec §5): transfer ID, file size, SHA-256,
//! compression, RaptorQ OTI and file name.

use std::fmt;

use raptorq::ObjectTransmissionInformation;

use crate::tile::CONTENT_BYTES;

pub const META_BYTES: usize = CONTENT_BYTES;
/// Longest file name in bytes.
pub const MAX_NAME_BYTES: usize = 38;
/// RaptorQ symbol size T.
pub const SYMBOL_SIZE: u16 = 96;
/// RaptorQ symbol alignment Al.
pub const ALIGNMENT: u8 = 8;
/// RFC 6330 K'max: most source symbols in one block.
pub const MAX_BLOCK_SYMBOLS: u64 = 56_403;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Compression {
    None = 0,
    DeflateRaw = 1,
}

impl Compression {
    pub fn name(self) -> &'static str {
        match self {
            Compression::None => "none",
            Compression::DeflateRaw => "deflate",
        }
    }
}

/// Decoded META contents. The transfer ID is derived, not stored: see [`Meta::id`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meta {
    /// Original file size in bytes.
    pub size: u64,
    /// SHA-256 of the original file.
    pub sha256: [u8; 32],
    pub compression: Compression,
    /// RFC 6330 serialized OTI; all zeros (F = 0) for an empty file.
    pub oti: [u8; 12],
    /// Base name, at most 38 bytes of UTF-8 (see [`truncate_filename`]).
    pub filename: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MetaError {
    /// Bytes 0..4 are not CRC-32C(META[4..96]).
    BadId,
    BadCompression(u8),
    BadName,
    /// The OTI does not describe a transfer this protocol can carry.
    BadOti,
}

impl fmt::Display for MetaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MetaError::BadId => f.write_str("transfer ID does not match META"),
            MetaError::BadCompression(c) => write!(f, "unknown compression {c}"),
            MetaError::BadName => f.write_str("bad file name"),
            MetaError::BadOti => f.write_str("unsupported RaptorQ parameters"),
        }
    }
}

impl std::error::Error for MetaError {}

impl Meta {
    /// Serializes to 96 bytes; offset 0 holds the transfer ID = CRC-32C(bytes 4..96).
    /// A longer file name is shortened with [`truncate_filename`].
    pub fn to_bytes(&self) -> [u8; META_BYTES] {
        let mut b = [0u8; META_BYTES];
        b[4..12].copy_from_slice(&self.size.to_be_bytes());
        b[12..44].copy_from_slice(&self.sha256);
        b[44] = self.compression as u8;
        b[45..57].copy_from_slice(&self.oti);
        let name = truncate_filename(&self.filename);
        b[57] = name.len() as u8;
        b[58..58 + name.len()].copy_from_slice(name.as_bytes());
        let id = transfer_id(&b);
        b[..4].copy_from_slice(&id.to_be_bytes());
        b
    }

    /// Parses and validates a META block, including its transfer ID.
    pub fn from_bytes(b: &[u8; META_BYTES]) -> Result<Meta, MetaError> {
        if u32::from_be_bytes([b[0], b[1], b[2], b[3]]) != transfer_id(b) {
            return Err(MetaError::BadId);
        }
        let compression = match b[44] {
            0 => Compression::None,
            1 => Compression::DeflateRaw,
            c => return Err(MetaError::BadCompression(c)),
        };
        let len = b[57] as usize;
        if len > MAX_NAME_BYTES || b[58 + len..].iter().any(|&x| x != 0) {
            return Err(MetaError::BadName);
        }
        let filename = std::str::from_utf8(&b[58..58 + len]).map_err(|_| MetaError::BadName)?.to_string();
        let meta = Meta {
            size: u64::from_be_bytes(b[4..12].try_into().expect("8 bytes")),
            sha256: b[12..44].try_into().expect("32 bytes"),
            compression,
            oti: b[45..57].try_into().expect("12 bytes"),
            filename,
        };
        meta.validate_oti()?;
        Ok(meta)
    }

    /// The transfer ID: CRC-32C over META bytes 4..96.
    pub fn id(&self) -> u32 {
        transfer_id(&self.to_bytes())
    }

    /// The tile tag: low 16 bits of the transfer ID.
    pub fn tag(&self) -> u16 {
        self.id() as u16
    }

    /// RaptorQ transfer length F (bytes after optional compression).
    pub fn transfer_length(&self) -> u64 {
        u64::from_be_bytes([0, 0, 0, self.oti[0], self.oti[1], self.oti[2], self.oti[3], self.oti[4]])
    }

    /// An empty file: F = 0 and no DATA tiles.
    pub fn is_empty_file(&self) -> bool {
        self.transfer_length() == 0
    }

    /// The RaptorQ parameters; `None` for an empty file.
    pub fn oti(&self) -> Option<ObjectTransmissionInformation> {
        (!self.is_empty_file()).then(|| ObjectTransmissionInformation::deserialize(&self.oti))
    }

    /// Source symbols K over all blocks.
    pub fn source_symbols(&self) -> u64 {
        self.transfer_length().div_ceil(SYMBOL_SIZE as u64)
    }

    fn validate_oti(&self) -> Result<(), MetaError> {
        let Some(oti) = self.oti() else {
            return match self.size {
                0 => Ok(()),
                _ => Err(MetaError::BadOti),
            };
        };
        let kt = self.source_symbols();
        let z = oti.source_blocks() as u64;
        let ok = oti.symbol_size() == SYMBOL_SIZE
            && oti.symbol_alignment() == ALIGNMENT
            && (1..=(SYMBOL_SIZE / ALIGNMENT as u16)).contains(&oti.sub_blocks())
            && z >= 1
            && z <= kt
            && kt.div_ceil(z) <= MAX_BLOCK_SYMBOLS
            && (self.compression == Compression::DeflateRaw || oti.transfer_length() == self.size);
        if ok {
            Ok(())
        } else {
            Err(MetaError::BadOti)
        }
    }
}

/// CRC-32C over bytes 4..96 of a serialized META block.
pub fn transfer_id(meta: &[u8; META_BYTES]) -> u32 {
    crate::crc32c(&meta[4..])
}

/// Shortens a file name to at most 38 bytes on a UTF-8 character boundary,
/// keeping the extension (from the last `.` that is not the first character)
/// when the extension itself is shorter than 38 bytes.
pub fn truncate_filename(name: &str) -> String {
    if name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot < MAX_NAME_BYTES => &name[dot..],
        _ => "",
    };
    let stem = &name[..name.len() - ext.len()];
    let mut cut = MAX_NAME_BYTES - ext.len();
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    if cut == 0 {
        // Keeping the extension would leave no stem (a hidden dot-file); cut the whole name instead.
        let mut cut = MAX_NAME_BYTES;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        return name[..cut].to_string();
    }
    format!("{}{}", &stem[..cut], ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_never_leaves_only_the_extension() {
        // A 37-byte extension after a multibyte stem: keeping it would leave ".eee…".
        let name = format!("보보.{}", "e".repeat(36));
        let t = truncate_filename(&name);
        assert!(t.len() <= MAX_NAME_BYTES && !t.starts_with('.'), "{t:?}");
        assert!(t.starts_with("보보"), "{t:?}");
    }

    fn sample() -> Meta {
        Meta {
            size: 1_000_000,
            sha256: [7; 32],
            compression: Compression::DeflateRaw,
            oti: ObjectTransmissionInformation::with_defaults(412_000, SYMBOL_SIZE).serialize(),
            filename: "report.pdf".into(),
        }
    }

    #[test]
    fn round_trip_and_id() {
        let meta = sample();
        let b = meta.to_bytes();
        assert_eq!(u32::from_be_bytes([b[0], b[1], b[2], b[3]]), crate::crc32c(&b[4..]));
        assert_eq!(&b[4..12], &1_000_000u64.to_be_bytes());
        assert_eq!(b[44], 1);
        assert_eq!(b[57], 10);
        assert_eq!(&b[58..68], b"report.pdf");
        assert!(b[68..].iter().all(|&x| x == 0));
        assert_eq!(Meta::from_bytes(&b), Ok(meta.clone()));
        assert_eq!(meta.tag(), meta.id() as u16);
        assert_eq!(meta.transfer_length(), 412_000);
    }

    #[test]
    fn id_depends_only_on_contents() {
        assert_eq!(sample().id(), sample().id());
        let mut other = sample();
        other.sha256[0] ^= 1;
        assert_ne!(sample().id(), other.id());
    }

    #[test]
    fn rejects_bad_meta() {
        let mut b = sample().to_bytes();
        b[20] ^= 1;
        assert_eq!(Meta::from_bytes(&b), Err(MetaError::BadId));

        let mut bad_t = sample();
        bad_t.oti = ObjectTransmissionInformation::new(412_000, 128, 1, 1, 8).serialize();
        assert_eq!(Meta::from_bytes(&bad_t.to_bytes()), Err(MetaError::BadOti));

        // Uncompressed transfers must have F == size.
        let mut mismatch = sample();
        mismatch.compression = Compression::None;
        assert_eq!(Meta::from_bytes(&mismatch.to_bytes()), Err(MetaError::BadOti));
    }

    #[test]
    fn empty_file_meta() {
        let meta =
            Meta { size: 0, sha256: [1; 32], compression: Compression::None, oti: [0; 12], filename: "e".into() };
        let parsed = Meta::from_bytes(&meta.to_bytes()).unwrap();
        assert!(parsed.is_empty_file());
        assert_eq!(parsed.oti(), None);
        assert_eq!(parsed.source_symbols(), 0);
    }

    #[test]
    fn filename_truncation() {
        assert_eq!(truncate_filename("short.txt"), "short.txt");
        let exact = "a".repeat(38);
        assert_eq!(truncate_filename(&exact), exact);

        let long = format!("{}.tar.gz", "x".repeat(60));
        let t = truncate_filename(&long);
        assert_eq!(t.len(), 38);
        assert!(t.ends_with(".gz") && t.starts_with("xxxx"));

        // Multi-byte characters are never split.
        let korean = format!("{}.pdf", "보고서".repeat(10)); // 90 + 4 bytes
        let t = truncate_filename(&korean);
        assert!(t.len() <= 38 && t.ends_with(".pdf"));
        let stem: String = "보고서".repeat(10).chars().take(11).collect(); // 33 of the 34 free bytes
        assert_eq!(t, format!("{stem}.pdf"));

        let emoji = format!("{}.md", "😀".repeat(20));
        let t = truncate_filename(&emoji);
        assert_eq!(t, format!("{}.md", "😀".repeat(8)));

        // No extension, a leading dot only, or an extension too long to keep.
        assert_eq!(truncate_filename(&"n".repeat(50)), "n".repeat(38));
        assert_eq!(truncate_filename(&format!(".{}", "h".repeat(50))).len(), 38);
        let huge_ext = format!("a.{}", "e".repeat(50));
        assert_eq!(truncate_filename(&huge_ext), huge_ext[..38]);
    }
}
