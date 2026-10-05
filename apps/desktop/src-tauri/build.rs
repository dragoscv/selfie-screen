use std::path::Path;

/// `bundle.externalBin` and `bundle.resources` must exist or tauri-build
/// fails. They are produced by `scripts/build-sidecar.mjs` (run before
/// `tauri build`); on a fresh clone, `cargo check` / `tauri dev` would break
/// without them, so create empty placeholders. The app never executes a
/// zero-byte runtime (see `sidecar::bundled_script`).
fn ensure_sidecar_placeholders() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let exe = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let runtime = format!("binaries/tiksee-sidecar-{target}{exe}");
    for placeholder in [runtime.as_str(), "resources/sidecar/dist/index.js"] {
        let path = Path::new(placeholder);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, b"");
        }
    }
}

fn main() {
    ensure_sidecar_placeholders();
    tauri_build::build()
}
