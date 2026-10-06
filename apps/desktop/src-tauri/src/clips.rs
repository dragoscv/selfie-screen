//! Studio clip files (WS28-07): the studio muxes the rolling H.264 buffer into
//! an MP4 and sends it here as a raw IPC body; Rust writes it under
//! `Videos\TikSee`. One call per save (~30 MB), so raw IPC is fine here.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri::ipc::{InvokeBody, Request};

/// Only names the studio generates (`TikSee-YYYYMMDD-HHMMSS.mp4`): no
/// separators, no `..`, bounded length.
fn valid_name(name: &str) -> bool {
    name.len() <= 80
        && name.ends_with(".mp4")
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.contains("..")
}

fn clip_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("TikSee"))
}

/// Write without clobbering: `name.mp4`, then `name-2.mp4`, ...
fn write_unique(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let stem = name.trim_end_matches(".mp4");
    for n in 1..100 {
        let file = if n == 1 {
            dir.join(name)
        } else {
            dir.join(format!("{stem}-{n}.mp4"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
        {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(bytes)
                    .map_err(|e| format!("write {}: {e}", file.display()))?;
                return Ok(file);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("open {}: {e}", file.display())),
        }
    }
    Err("too many clips with the same name".into())
}

/// Raw MP4 body; the `x-name` header is the file name. Returns the full path.
#[tauri::command]
pub async fn clip_save(app: tauri::AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw MP4 body".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !valid_name(name) {
        return Err(format!("invalid clip name '{name}'"));
    }
    if bytes.len() < 8 {
        return Err("empty clip".into());
    }
    let file = write_unique(&clip_dir(&app)?, name, bytes)?;
    log::info!("clip saved: {} ({} bytes)", file.display(), bytes.len());
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_generated_names_are_accepted() {
        assert!(valid_name("TikSee-20261006-041530.mp4"));
        assert!(!valid_name("..\\evil.mp4"));
        assert!(!valid_name("a/b.mp4"));
        assert!(!valid_name("clip.exe"));
        assert!(!valid_name(".mp4"));
        assert!(!valid_name("a..mp4"));
        assert!(!valid_name(&format!("{}.mp4", "a".repeat(80))));
    }

    #[test]
    fn writes_never_clobber_an_existing_clip() {
        let dir = std::env::temp_dir().join(format!("tiksee-clips-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = write_unique(&dir, "x.mp4", b"first").unwrap();
        let b = write_unique(&dir, "x.mp4", b"second").unwrap();
        assert_eq!(a.file_name().unwrap(), "x.mp4");
        assert_eq!(b.file_name().unwrap(), "x-2.mp4");
        assert_eq!(std::fs::read(&a).unwrap(), b"first");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
