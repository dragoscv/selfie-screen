//! Phone mirror: the studio's output on a phone screen, so TikTok's mobile
//! "screen share" LIVE can broadcast it (Android has no virtual camera
//! without root).
//!
//! The virtual-camera producer offers every NV12 frame here; a tiny HTTP
//! server on 127.0.0.1 serves `/<token>/` (a full-screen page) and
//! `/<token>/stream.mjpg` (multipart JPEG). The phone reaches it through
//! `adb reverse tcp:P tcp:P` — over USB or WiFi adb — so nothing listens on
//! the LAN. `mirror_start` sets up the reverse and opens the page on the phone.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Preferred port (stable phone URL); falls back to an ephemeral one.
const PREFERRED_PORT: u16 = 15380;
/// Frames offered faster than this are dropped before the 3 MB copy.
const MAX_FPS: u64 = 30;
const JPEG_QUALITY: u8 = 80;
const BOUNDARY: &str = "tikseeframe";

struct Frame {
    seq: u64,
    width: u32,
    height: u32,
    nv12: Vec<u8>,
}

#[derive(Default)]
struct Shared {
    frame: Mutex<Option<Frame>>,
    ready: Condvar,
    clients: AtomicUsize,
    sent: AtomicU64,
    /// `ms since start + 1` of the last accepted offer (0 = none).
    last_offer: AtomicU64,
}

struct Server {
    port: u16,
    token: String,
    shared: Arc<Shared>,
    started: Instant,
}

static SERVER: OnceLock<Server> = OnceLock::new();
static OFFER_EPOCH: OnceLock<Instant> = OnceLock::new();

/// Called by the vcam producer for every frame; near-free with no phone attached.
pub fn offer(width: u32, height: u32, nv12: &[u8]) {
    let Some(server) = SERVER.get() else { return };
    let shared = &server.shared;
    if shared.clients.load(Ordering::Relaxed) == 0 {
        return;
    }
    let now = OFFER_EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1;
    let last = shared.last_offer.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 1000 / MAX_FPS {
        return;
    }
    shared.last_offer.store(now, Ordering::Relaxed);
    let mut slot = shared.frame.lock().unwrap_or_else(PoisonError::into_inner);
    let seq = slot.as_ref().map_or(1, |f| f.seq + 1);
    match slot.as_mut() {
        Some(f) if f.nv12.len() == nv12.len() => {
            f.nv12.copy_from_slice(nv12);
            f.seq = seq;
            f.width = width;
            f.height = height;
        }
        _ => {
            *slot = Some(Frame {
                seq,
                width,
                height,
                nv12: nv12.to_vec(),
            });
        }
    }
    shared.ready.notify_all();
}

/// NV12 → interleaved full-resolution YCbCr (what the JPEG encoder takes).
fn nv12_to_ycbcr(width: usize, height: usize, nv12: &[u8], out: &mut Vec<u8>) -> bool {
    let y_len = width * height;
    if nv12.len() < y_len + y_len / 2 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return false;
    }
    let (y_plane, uv) = nv12.split_at(y_len);
    out.resize(y_len * 3, 0);
    for row in 0..height {
        let y_row = &y_plane[row * width..(row + 1) * width];
        let uv_row = &uv[(row / 2) * width..(row / 2) * width + width];
        let dst = &mut out[row * width * 3..(row + 1) * width * 3];
        for (x, px) in dst.as_chunks_mut::<3>().0.iter_mut().enumerate() {
            let c = x & !1;
            px[0] = y_row[x];
            px[1] = uv_row[c];
            px[2] = uv_row[c + 1];
        }
    }
    true
}

fn encode_jpeg(frame: &Frame, scratch: &mut Vec<u8>) -> Option<Vec<u8>> {
    let (w, h) = (frame.width as usize, frame.height as usize);
    if !nv12_to_ycbcr(w, h, &frame.nv12, scratch) {
        return None;
    }
    let mut jpeg = Vec::with_capacity(w * h / 4);
    let encoder = jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY);
    encoder
        .encode(
            scratch,
            u16::try_from(w).ok()?,
            u16::try_from(h).ok()?,
            jpeg_encoder::ColorType::Ycbcr,
        )
        .ok()?;
    Some(jpeg)
}

const PAGE: &str = r#"<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>TikSee</title><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
img{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain}
#hint{position:fixed;left:0;right:0;bottom:24px;text-align:center;color:#fff8;font:14px system-ui}
:fullscreen #hint{display:none}
</style></head><body><img id="v" alt=""><div id="hint">Atinge pentru ecran complet</div><script>
const v=document.getElementById("v");let lock=null;
const load=()=>{v.src="stream.mjpg?t="+Date.now()};
v.onerror=()=>setTimeout(load,1000);load();
document.body.onclick=async()=>{try{await document.documentElement.requestFullscreen()}catch{}
try{lock=await navigator.wakeLock.request("screen")}catch{}};
document.onvisibilitychange=async()=>{if(document.visibilityState==="visible"&&lock){try{lock=await navigator.wakeLock.request("screen")}catch{}}};
</script></body></html>"#;

fn read_path(stream: &mut TcpStream) -> Option<String> {
    let mut buf = [0u8; 4096];
    let mut len = 0;
    while len < buf.len() {
        let n = stream.read(&mut buf[len..]).ok()?;
        if n == 0 {
            return None;
        }
        len += n;
        if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = std::str::from_utf8(&buf[..len]).ok()?;
    let mut parts = head.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    Some(target.split('?').next().unwrap_or(target).to_owned())
}

fn handle(mut stream: TcpStream, token: &str, shared: &Shared) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Some(path) = read_path(&mut stream) else {
        return;
    };
    let base = format!("/{token}/");
    if path == base {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{PAGE}",
            PAGE.len()
        );
        return;
    }
    if path != format!("{base}stream.mjpg") {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
    }
    if stream
        .write_all(
            format!("HTTP/1.1 200 OK\r\ncontent-type: multipart/x-mixed-replace; boundary={BOUNDARY}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n")
                .as_bytes(),
        )
        .is_err()
    {
        return;
    }
    shared.clients.fetch_add(1, Ordering::Relaxed);
    log::info!("mirror: phone attached");
    stream_frames(&mut stream, shared);
    shared.clients.fetch_sub(1, Ordering::Relaxed);
    log::info!("mirror: phone detached");
}

fn stream_frames(stream: &mut TcpStream, shared: &Shared) {
    let mut last_seq = 0u64;
    let mut scratch = Vec::new();
    loop {
        let jpeg = {
            let guard = shared.frame.lock().unwrap_or_else(PoisonError::into_inner);
            let (guard, _) = shared
                .ready
                .wait_timeout_while(guard, Duration::from_secs(2), |f| {
                    f.as_ref().is_none_or(|f| f.seq == last_seq)
                })
                .unwrap_or_else(PoisonError::into_inner);
            match guard.as_ref() {
                Some(f) if f.seq != last_seq => {
                    last_seq = f.seq;
                    // Encoding under the lock blocks only the next offer's copy, never the studio.
                    encode_jpeg(f, &mut scratch)
                }
                _ => None,
            }
        };
        let Some(jpeg) = jpeg else {
            // No frame for 2 s: probe the socket so a closed tab ends the thread.
            if stream.write_all(b"\r\n").is_err() {
                return;
            }
            continue;
        };
        let head = format!(
            "--{BOUNDARY}\r\ncontent-type: image/jpeg\r\ncontent-length: {}\r\n\r\n",
            jpeg.len()
        );
        if stream.write_all(head.as_bytes()).is_err()
            || stream.write_all(&jpeg).is_err()
            || stream.write_all(b"\r\n").is_err()
        {
            return;
        }
        shared.sent.fetch_add(1, Ordering::Relaxed);
    }
}

fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{:016x}", h.finish())
}

fn server() -> Result<&'static Server, String> {
    if let Some(s) = SERVER.get() {
        return Ok(s);
    }
    let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("mirror: bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = Server {
        port,
        token: token(),
        shared: Arc::new(Shared::default()),
        started: Instant::now(),
    };
    let token = server.token.clone();
    let shared = Arc::clone(&server.shared);
    std::thread::Builder::new()
        .name("mirror-http".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let token = token.clone();
                let shared = Arc::clone(&shared);
                let _ = std::thread::Builder::new()
                    .name("mirror-client".into())
                    .spawn(move || handle(stream, &token, &shared));
            }
        })
        .map_err(|e| e.to_string())?;
    log::info!("mirror: serving on 127.0.0.1:{port}");
    // A racing caller may have won; its server is the one that stays.
    let _ = SERVER.set(server);
    SERVER.get().ok_or_else(|| "mirror: server not set".into())
}

/* ------------------------------------------------------------------ *
 * adb
 * ------------------------------------------------------------------ */

fn adb_path() -> String {
    let candidates = [
        std::env::var("ANDROID_HOME").ok(),
        std::env::var("ANDROID_SDK_ROOT").ok(),
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| format!("{d}\\Android\\Sdk")),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(|root| {
            std::path::Path::new(&root)
                .join("platform-tools")
                .join("adb.exe")
        })
        .find(|p| p.is_file())
        .map_or_else(|| "adb".to_owned(), |p| p.display().to_string())
}

fn adb(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(adb_path());
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("adb not found or failed to start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "adb {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub model: String,
    /// "usb" or "wifi" (serial is host:port).
    pub transport: &'static str,
}

fn parse_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            if parts.next()? != "device" {
                return None;
            }
            let model = parts
                .find_map(|p| p.strip_prefix("model:"))
                .unwrap_or(serial)
                .replace('_', " ");
            let transport = if serial.contains(':') || serial.contains("._adb-tls-") {
                "wifi"
            } else {
                "usb"
            };
            Some(AdbDevice {
                serial: serial.to_owned(),
                model,
                transport,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub running: bool,
    pub port: u16,
    pub clients: usize,
    pub frames_sent: u64,
    pub uptime_s: u64,
}

#[tauri::command]
pub async fn mirror_devices() -> Result<Vec<AdbDevice>, String> {
    tauri::async_runtime::spawn_blocking(|| adb(&["devices", "-l"]).map(|o| parse_devices(&o)))
        .await
        .map_err(|e| e.to_string())?
}

/// Starts the server, `adb reverse`s its port on `serial` and opens the page there.
#[tauri::command]
pub async fn mirror_start(serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = server()?;
        let port = format!("tcp:{}", s.port);
        adb(&["-s", &serial, "reverse", &port, &port])?;
        let url = format!("http://localhost:{}/{}/", s.port, s.token);
        adb(&[
            "-s",
            &serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            &url,
        ])?;
        log::info!("mirror: started on {serial}");
        Ok(url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mirror_stop(serial: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = SERVER.get() {
            let port = format!("tcp:{}", s.port);
            adb(&["-s", &serial, "reverse", "--remove", &port])?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mirror_status() -> MirrorStatus {
    SERVER.get().map_or(
        MirrorStatus {
            running: false,
            port: 0,
            clients: 0,
            frames_sent: 0,
            uptime_s: 0,
        },
        |s| MirrorStatus {
            running: true,
            port: s.port,
            clients: s.shared.clients.load(Ordering::Relaxed),
            frames_sent: s.shared.sent.load(Ordering::Relaxed),
            uptime_s: s.started.elapsed().as_secs(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usb_and_wifi_devices() {
        let out = "List of devices attached\nR58N94BMLJY            device product:a51nseea model:SM_A515F device:a51 transport_id:5\n192.168.1.20:5555 device product:x model:SM_S938B transport_id:7\nZZ unauthorized transport_id:9\n";
        let d = parse_devices(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].model, "SM A515F");
        assert_eq!(d[0].transport, "usb");
        assert_eq!(d[1].transport, "wifi");
    }

    #[test]
    fn converts_nv12_and_encodes_a_jpeg() {
        let (w, h) = (4usize, 2usize);
        let mut nv12 = vec![128u8; w * h + w * h / 2];
        nv12[0] = 255;
        let mut out = Vec::new();
        assert!(nv12_to_ycbcr(w, h, &nv12, &mut out));
        assert_eq!(out.len(), w * h * 3);
        assert_eq!(&out[0..3], &[255, 128, 128]);
        let frame = Frame {
            seq: 1,
            width: 16,
            height: 16,
            nv12: vec![100; 16 * 16 * 3 / 2],
        };
        let jpeg = encode_jpeg(&frame, &mut out).expect("jpeg");
        assert_eq!(&jpeg[0..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn rejects_short_or_odd_frames() {
        let mut out = Vec::new();
        assert!(!nv12_to_ycbcr(4, 2, &[0; 5], &mut out));
        assert!(!nv12_to_ycbcr(3, 2, &[0; 9], &mut out));
    }
}
