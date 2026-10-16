//! Live probe: registers the vocal engine on Voicemeeter strip 1 for a few
//! seconds and prints status + meters.
//! `cargo run --example vocal_probe -- [strip0] [secs] [monitorBus 1-5]`
//! (the monitor bus is switched on for the test and restored afterwards).
//! `vocal_probe dump` prints the Voicemeeter state; `vocal_probe vmcycle <dir>
//! <mic0> <music0> <phones1-5>` checks backup -> live preset -> restore.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "script") {
        tiksee_lib::vocal_script(args.get(2).map_or("", String::as_str));
        return;
    }
    if args.get(1).is_some_and(|a| a == "capture") {
        let strip = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        let secs = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
        tiksee_lib::vocal_capture(
            strip,
            secs,
            args.get(4).map_or("capture.wav", String::as_str),
        );
        return;
    }
    if args.get(1).is_some_and(|a| a == "keytest") {
        tiksee_lib::vocal_keytest(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0));
        return;
    }
    if args.get(1).is_some_and(|a| a == "bus") {
        let ch = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(48);
        let secs = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
        tiksee_lib::vocal_capture_bus(ch, secs, args.get(4).map_or("bus.wav", String::as_str));
        return;
    }
    if args.get(1).is_some_and(|a| a == "analyze") {
        let path = args.get(2).map_or("capture.wav", String::as_str);
        let bytes = std::fs::read(path).expect("read wav");
        let sr = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) as f32;
        let data: Vec<f32> = bytes[44..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        let r = tiksee_vocal::analysis::noise(&data, sr);
        println!(
            "sr={sr} n={} rms={:.1} floor={:.1} peak={:.1} hum={:?}",
            data.len(),
            r.rms_db,
            r.floor_db,
            r.peak_db,
            r.hum_hz
        );
        for t in &r.tones {
            println!(
                "tone {:.1} Hz {:.1} dBFS (+{:.1} dB)",
                t.hz, t.db, t.prominence_db
            );
        }
        return;
    }
    if args.get(1).is_some_and(|a| a == "vmcycle") {
        // vmcycle <dir> <mic0> <music0> <phonesBus1-5>
        let n = |i: usize, d: i32| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
        let dir = args.get(2).map_or(".", String::as_str);
        let ok = tiksee_lib::vocal_vm_cycle(dir, n(3, 0), n(4, 5), n(5, 5));
        std::process::exit(i32::from(!ok));
    }
    if args.get(1).is_some_and(|a| a == "dump") {
        tiksee_lib::vocal_dump();
        return;
    }
    let strip: i32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    let monitor: Option<i32> = args.get(3).and_then(|s| s.parse().ok());
    tiksee_lib::vocal_probe(strip, secs, monitor);
}
