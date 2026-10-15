//! Live probe: registers the vocal engine on Voicemeeter strip 1 for a few
//! seconds and prints status + meters.
//! `cargo run --example vocal_probe -- [strip0] [secs] [monitorBus 1-5]`
//! (the monitor bus is switched on for the test and restored afterwards).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "script") {
        tiksee_lib::vocal_script(args.get(2).map_or("", String::as_str));
        return;
    }
    let strip: i32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    let monitor: Option<i32> = args.get(3).and_then(|s| s.parse().ok());
    tiksee_lib::vocal_probe(strip, secs, monitor);
}
