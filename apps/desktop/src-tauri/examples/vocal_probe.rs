//! Live probe: registers the vocal engine on Voicemeeter strip 1 for a few
//! seconds and prints status + meters. `cargo run --example vocal_probe -- [strip] [secs]`.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let strip: i32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    tiksee_lib::vocal_probe(strip, secs);
}
