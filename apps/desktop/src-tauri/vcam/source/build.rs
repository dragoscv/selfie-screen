//! COM entry points must be PRIVATE exports (not in the import library);
//! without the .def file MSVC link warns LNK4104 for each of them.
fn main() {
    println!("cargo:rerun-if-changed=exports.def");
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("windows-msvc") {
        let def = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("exports.def");
        println!("cargo:rustc-cdylib-link-arg=/DEF:{}", def.display());
    }
}
