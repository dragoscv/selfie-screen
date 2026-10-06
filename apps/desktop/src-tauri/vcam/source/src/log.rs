//! Best-effort diagnostics in `%ProgramData%\TikSee\vcam.log`.
//!
//! The Frame Server runs the DLL as LocalService in session 0 with no
//! console, so a small rolling file is the only way to see what happened.
//! Never logs frame data or anything user-identifying.

use std::fmt;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 256 * 1024;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramData")?;
    Some(PathBuf::from(base).join("TikSee").join("vcam.log"))
}

pub(crate) fn write(args: fmt::Arguments<'_>) {
    if cfg!(test) {
        return;
    }
    let Some(path) = path() else { return };
    let _guard = crate::util::lock(&LOCK);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{} pid={} {}",
            tiksee_vcam_shared::win::tick_ms(),
            std::process::id(),
            args
        );
    }
}

macro_rules! vlog {
    ($($arg:tt)*) => {
        $crate::log::write(format_args!($($arg)*))
    };
}
