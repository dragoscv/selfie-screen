//! Runs the TikSee vocal engine inside Voicemeeter's audio thread.
//!
//! `VoicemeeterRemote64.dll` is loaded at runtime; the engine registers the
//! INPUT-insert callback, so the corrected voice replaces the mic strip's
//! signal before Voicemeeter's own strip processing: headphones (A1) and
//! the live (B1) get it in the same buffer, with no extra device hop.
//!
//! Real-time rules in the callback: no allocation, no blocking lock. New
//! parameters arrive through a version counter + `try_lock`; meters leave
//! the same way.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tiksee_vocal::{Engine, Meter, VocalParams};

pub use imp::VocalCtl;

/// Strip indices (0-based) as Voicemeeter numbers them.
pub const MAX_STRIPS: i32 = 8;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalStatus {
    /// Voicemeeter Remote DLL found and Voicemeeter running.
    pub available: bool,
    /// 1 Standard, 2 Banana, 3 Potato.
    pub vm_type: i32,
    pub running: bool,
    pub mic_strip: i32,
    pub music_strip: i32,
    pub sample_rate: u32,
    pub block: u32,
    /// Another app already owns the input-insert callback.
    pub conflict: Option<String>,
    pub error: Option<String>,
    /// Audio callbacks since start (proves the stream is alive).
    pub callbacks: u64,
    /// Peak (dBFS) of every input-insert channel over the last ~0.5 s.
    pub channel_peaks_db: Vec<f32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalMeter {
    #[serde(flatten)]
    pub meter: Meter,
    pub running: bool,
}

/// State shared between the control side and the audio callback.
pub struct Shared {
    params: Mutex<VocalParams>,
    version: AtomicU64,
    meter: Mutex<Meter>,
    mic_strip: AtomicI32,
    music_strip: AtomicI32,
    vm_type: AtomicI32,
    restart: AtomicBool,
    callbacks: AtomicU64,
    sample_rate: AtomicU64,
    block: AtomicU64,
    peaks: Box<[AtomicU32]>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            params: Mutex::default(),
            version: AtomicU64::default(),
            meter: Mutex::default(),
            mic_strip: AtomicI32::default(),
            music_strip: AtomicI32::new(-1),
            vm_type: AtomicI32::default(),
            restart: AtomicBool::default(),
            callbacks: AtomicU64::default(),
            sample_rate: AtomicU64::default(),
            block: AtomicU64::default(),
            peaks: (0..34).map(|_| AtomicU32::new(0)).collect(),
        }
    }
}

impl Shared {
    pub fn set_params(&self, p: VocalParams) {
        *self.params.lock().unwrap_or_else(PoisonError::into_inner) = p;
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Reads and resets the per-channel peaks.
    pub fn take_peaks(&self) -> Vec<f32> {
        self.peaks
            .iter()
            .map(|p| {
                20.0 * f32::from_bits(p.swap(0, Ordering::Relaxed))
                    .max(1e-9)
                    .log10()
            })
            .collect()
    }
}

/// `(first channel, channel count)` of `strip` in the INPUT-insert buffer.
pub fn strip_channels(vm_type: i32, strip: i32) -> Option<(usize, usize)> {
    let hw = match vm_type {
        1 => 2,
        2 => 3,
        3 => 5,
        _ => return None,
    };
    let virt = match vm_type {
        1 => 1,
        2 => 2,
        _ => 3,
    };
    if strip < 0 || strip >= hw + virt {
        return None;
    }
    let s = strip as usize;
    let hw = hw as usize;
    if s < hw {
        Some((s * 2, 2))
    } else {
        Some((hw * 2 + (s - hw) * 8, 8))
    }
}

/// Audio-thread state, created on STARTING (allowed to allocate there).
pub struct Dsp {
    engine: Engine,
    version: u64,
    since_meter: u32,
}

impl Dsp {
    fn new(sample_rate: f32, shared: &Shared) -> Self {
        let params = *shared.params.lock().unwrap_or_else(PoisonError::into_inner);
        Self {
            engine: Engine::new(sample_rate, params),
            version: shared.version.load(Ordering::Acquire),
            since_meter: 0,
        }
    }

    /// Processes one INPUT-insert buffer. `read`/`write` are Voicemeeter's channel pointers.
    ///
    /// # Safety
    /// Every pointer in `read[..nbi]` / `write[..nbo]` must be valid for `nbs` floats.
    unsafe fn process(
        &mut self,
        shared: &Shared,
        read: &[*mut f32],
        write: &[*mut f32],
        nbs: usize,
    ) {
        let v = shared.version.load(Ordering::Acquire);
        if v != self.version
            && let Ok(p) = shared.params.try_lock()
        {
            self.engine.set_params(*p);
            self.version = v;
        }
        let vm_type = shared.vm_type.load(Ordering::Relaxed);
        let n = read.len().min(write.len());
        for (ch, slot) in shared.peaks.iter().enumerate().take(n) {
            if read[ch].is_null() {
                continue;
            }
            let mut peak = 0.0f32;
            for i in 0..nbs {
                // SAFETY: caller guarantees nbs valid floats.
                peak = peak.max(unsafe { *read[ch].add(i) }.abs());
            }
            if peak > f32::from_bits(slot.load(Ordering::Relaxed)) {
                slot.store(peak.to_bits(), Ordering::Relaxed);
            }
        }
        // Insert semantics: every channel must be written, so pass through first.
        for ch in 0..n {
            let (r, w) = (read[ch], write[ch]);
            if r != w && !r.is_null() && !w.is_null() {
                // SAFETY: caller guarantees nbs valid floats on both.
                unsafe { std::ptr::copy_nonoverlapping(r, w, nbs) };
            }
        }
        let duck = self.engine.params().duck.on;
        if let Some((m0, mc)) = strip_channels(vm_type, shared.music_strip.load(Ordering::Relaxed))
            && m0 + 1 < n
        {
            for i in 0..nbs {
                // SAFETY: channel indices are < n and pointers are valid for nbs.
                let x = unsafe { (*read[m0].add(i) + *read[m0 + 1].add(i)) * 0.5 };
                let g = self.engine.music_sample(x);
                if duck {
                    for w in &write[m0..(m0 + mc).min(n)] {
                        unsafe { *w.add(i) *= g };
                    }
                }
            }
        }
        if let Some((v0, _)) = strip_channels(vm_type, shared.mic_strip.load(Ordering::Relaxed))
            && v0 + 1 < n
        {
            for i in 0..nbs {
                // A mono mic on a hardware strip arrives on the left channel.
                let x = unsafe { *read[v0].add(i) };
                let (l, r) = self.engine.sample(x);
                unsafe {
                    *write[v0].add(i) = l;
                    *write[v0 + 1].add(i) = r;
                }
            }
        }
        self.since_meter += nbs as u32;
        if self.since_meter as f32 >= self.engine.sample_rate() / 60.0 {
            self.since_meter = 0;
            if let Ok(mut m) = shared.meter.try_lock() {
                *m = self.engine.meter();
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::{CStr, c_char, c_long, c_void};
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Duration;

    use libloading::Library;

    use super::{Dsp, MAX_STRIPS, Shared, VocalMeter, VocalStatus};

    type Callback = unsafe extern "system" fn(*mut c_void, c_long, *mut c_void, c_long) -> c_long;

    #[repr(C)]
    struct AudioInfo {
        samplerate: c_long,
        nb_sample_per_frame: c_long,
    }

    #[repr(C)]
    struct AudioBuffer {
        sr: c_long,
        nbs: c_long,
        nbi: c_long,
        nbo: c_long,
        r: [*mut f32; 128],
        w: [*mut f32; 128],
    }

    const CB_STARTING: c_long = 1;
    const CB_ENDING: c_long = 2;
    const CB_CHANGE: c_long = 3;
    const CB_BUFFER_IN: c_long = 10;
    const MODE_IN: c_long = 1;

    struct Api {
        _lib: Library,
        login: unsafe extern "system" fn() -> c_long,
        logout: unsafe extern "system" fn() -> c_long,
        get_type: unsafe extern "system" fn(*mut c_long) -> c_long,
        set_parameters: unsafe extern "system" fn(*const c_char) -> c_long,
        set_string: unsafe extern "system" fn(*const c_char, *const c_char) -> c_long,
        get_string: unsafe extern "system" fn(*const c_char, *mut c_char) -> c_long,
        get_level: unsafe extern "system" fn(c_long, c_long, *mut f32) -> c_long,
        get_float: unsafe extern "system" fn(*const c_char, *mut f32) -> c_long,
        is_dirty: unsafe extern "system" fn() -> c_long,
        cb_register:
            unsafe extern "system" fn(c_long, Callback, *mut c_void, *mut c_char) -> c_long,
        cb_start: unsafe extern "system" fn() -> c_long,
        cb_unregister: unsafe extern "system" fn() -> c_long,
    }

    impl Api {
        fn load() -> Result<Self, String> {
            let path = dll_path()
                .ok_or("Voicemeeter is not installed (VoicemeeterRemote64.dll not found)")?;
            // SAFETY: loading VB-Audio's DLL; symbols are resolved with their documented signatures.
            unsafe {
                let lib =
                    Library::new(&path).map_err(|e| format!("load {}: {e}", path.display()))?;
                macro_rules! sym {
                    ($name:literal) => {
                        *lib.get(concat!($name, "\0").as_bytes())
                            .map_err(|e| format!("{}: {e}", $name))?
                    };
                }
                Ok(Self {
                    login: sym!("VBVMR_Login"),
                    logout: sym!("VBVMR_Logout"),
                    get_type: sym!("VBVMR_GetVoicemeeterType"),
                    set_parameters: sym!("VBVMR_SetParameters"),
                    set_string: sym!("VBVMR_SetParameterStringA"),
                    get_string: sym!("VBVMR_GetParameterStringA"),
                    get_level: sym!("VBVMR_GetLevel"),
                    get_float: sym!("VBVMR_GetParameterFloat"),
                    is_dirty: sym!("VBVMR_IsParametersDirty"),
                    cb_register: sym!("VBVMR_AudioCallbackRegister"),
                    cb_start: sym!("VBVMR_AudioCallbackStart"),
                    cb_unregister: sym!("VBVMR_AudioCallbackUnregister"),
                    _lib: lib,
                })
            }
        }
    }

    fn dll_path() -> Option<PathBuf> {
        let candidates = [
            std::env::var("ProgramFiles(x86)")
                .ok()
                .map(|p| PathBuf::from(p).join("VB\\Voicemeeter")),
            std::env::var("ProgramFiles")
                .ok()
                .map(|p| PathBuf::from(p).join("VB\\Voicemeeter")),
        ];
        candidates
            .into_iter()
            .flatten()
            .map(|d| d.join("VoicemeeterRemote64.dll"))
            .find(|p| p.is_file())
    }

    /// Box handed to Voicemeeter as `lpUser`.
    struct CbState {
        shared: Arc<Shared>,
        dsp: Option<Dsp>,
    }

    unsafe extern "system" fn callback(
        user: *mut c_void,
        cmd: c_long,
        data: *mut c_void,
        _nnn: c_long,
    ) -> c_long {
        if user.is_null() {
            return 0;
        }
        // SAFETY: `user` is the CbState box registered below; Voicemeeter calls
        // this from one thread and never re-enters it.
        let state = unsafe { &mut *user.cast::<CbState>() };
        match cmd {
            CB_STARTING if !data.is_null() => {
                // SAFETY: STARTING passes an AudioInfo.
                let info = unsafe { &*data.cast::<AudioInfo>() };
                let sr = info.samplerate.max(8000) as f32;
                state
                    .shared
                    .sample_rate
                    .store(info.samplerate as u64, Ordering::Relaxed);
                state
                    .shared
                    .block
                    .store(info.nb_sample_per_frame as u64, Ordering::Relaxed);
                state.dsp = Some(Dsp::new(sr, &state.shared));
            }
            CB_ENDING => state.dsp = None,
            CB_CHANGE => state.shared.restart.store(true, Ordering::Release),
            CB_BUFFER_IN if !data.is_null() => {
                // SAFETY: BUFFER_IN passes an AudioBuffer whose pointers are valid for nbs samples.
                let buf = unsafe { &*data.cast::<AudioBuffer>() };
                state.shared.callbacks.fetch_add(1, Ordering::Relaxed);
                let nbi = (buf.nbi.max(0) as usize).min(128);
                let nbo = (buf.nbo.max(0) as usize).min(128);
                let nbs = buf.nbs.max(0) as usize;
                match state.dsp.as_mut() {
                    // SAFETY: as above.
                    Some(dsp) => unsafe {
                        dsp.process(&state.shared, &buf.r[..nbi], &buf.w[..nbo], nbs)
                    },
                    None => {
                        for ch in 0..nbi.min(nbo) {
                            if buf.r[ch] != buf.w[ch]
                                && !buf.r[ch].is_null()
                                && !buf.w[ch].is_null()
                            {
                                unsafe { std::ptr::copy_nonoverlapping(buf.r[ch], buf.w[ch], nbs) };
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        0
    }

    struct Running {
        state: *mut CbState,
        watcher_stop: Arc<std::sync::atomic::AtomicBool>,
    }

    // SAFETY: the raw pointer is only freed by the control side after unregister.
    unsafe impl Send for Running {}

    #[derive(Default)]
    struct Inner {
        api: Option<Arc<Api>>,
        logged_in: bool,
        running: Option<Running>,
        conflict: Option<String>,
        error: Option<String>,
    }

    #[derive(Default)]
    pub struct VocalCtl {
        inner: Mutex<Inner>,
        shared: Arc<Shared>,
    }

    impl VocalCtl {
        fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
            self.inner.lock().unwrap_or_else(PoisonError::into_inner)
        }

        fn api(inner: &mut Inner) -> Result<Arc<Api>, String> {
            if inner.api.is_none() {
                inner.api = Some(Arc::new(Api::load()?));
            }
            let api = inner.api.clone().ok_or("api")?;
            if !inner.logged_in {
                // SAFETY: documented call, once per process session.
                let rep = unsafe { (api.login)() };
                if rep < 0 {
                    return Err(format!("VBVMR_Login failed ({rep})"));
                }
                inner.logged_in = true;
            }
            Ok(api)
        }

        fn vm_type(api: &Api) -> Option<i32> {
            let mut t: c_long = 0;
            // SAFETY: out pointer to a local.
            let rep = unsafe { (api.get_type)(&mut t) };
            (rep == 0 && t > 0).then_some(t)
        }

        pub fn status(&self) -> VocalStatus {
            let mut inner = self.lock();
            let api = Self::api(&mut inner);
            let vm_type = api
                .as_ref()
                .ok()
                .and_then(|a| Self::vm_type(a))
                .unwrap_or(0);
            let s = &self.shared;
            VocalStatus {
                available: vm_type > 0,
                vm_type,
                running: inner.running.is_some(),
                mic_strip: s.mic_strip.load(Ordering::Relaxed),
                music_strip: s.music_strip.load(Ordering::Relaxed),
                sample_rate: s.sample_rate.load(Ordering::Relaxed) as u32,
                block: s.block.load(Ordering::Relaxed) as u32,
                conflict: inner.conflict.clone(),
                error: inner.error.clone().or_else(|| api.err()),
                callbacks: s.callbacks.load(Ordering::Relaxed),
                channel_peaks_db: if inner.running.is_some() {
                    s.take_peaks()
                } else {
                    Vec::new()
                },
            }
        }

        pub fn meter(&self) -> VocalMeter {
            let running = self.lock().running.is_some();
            let meter = *self
                .shared
                .meter
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            VocalMeter { meter, running }
        }

        pub fn set_params(&self, params: tiksee_vocal::VocalParams) {
            self.shared.set_params(params);
        }

        pub fn start(&self, mic_strip: i32, music_strip: i32) -> Result<(), String> {
            let mut inner = self.lock();
            let api = Self::api(&mut inner)?;
            let vm_type = Self::vm_type(&api).ok_or("Voicemeeter is not running")?;
            if super::strip_channels(vm_type, mic_strip).is_none() {
                return Err(format!(
                    "strip {} does not exist on this Voicemeeter",
                    mic_strip + 1
                ));
            }
            self.shared.mic_strip.store(mic_strip, Ordering::Relaxed);
            self.shared
                .music_strip
                .store(music_strip.clamp(-1, MAX_STRIPS - 1), Ordering::Relaxed);
            self.shared.vm_type.store(vm_type, Ordering::Relaxed);
            if inner.running.is_some() {
                return Ok(());
            }
            let state = Box::into_raw(Box::new(CbState {
                shared: Arc::clone(&self.shared),
                dsp: None,
            }));
            let mut name = [0 as c_char; 64];
            for (d, s) in name.iter_mut().zip(b"TikSee Vocal\0") {
                *d = *s as c_char;
            }
            // SAFETY: callback + user pointer stay valid until unregister in stop().
            let rep =
                unsafe { (api.cb_register)(MODE_IN, callback, state.cast(), name.as_mut_ptr()) };
            if rep != 0 {
                // SAFETY: not registered, so we still own the box.
                drop(unsafe { Box::from_raw(state) });
                if rep == 1 {
                    // SAFETY: Voicemeeter wrote a NUL-terminated name.
                    let other = unsafe { CStr::from_ptr(name.as_ptr()) }
                        .to_string_lossy()
                        .into_owned();
                    inner.conflict = Some(other.clone());
                    return Err(format!("input insert already used by {other}"));
                }
                return Err(format!("VBVMR_AudioCallbackRegister failed ({rep})"));
            }
            // SAFETY: registered above.
            let rep = unsafe { (api.cb_start)() };
            if rep != 0 {
                unsafe { (api.cb_unregister)() };
                drop(unsafe { Box::from_raw(state) });
                return Err(format!("VBVMR_AudioCallbackStart failed ({rep})"));
            }
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            spawn_watcher(
                Arc::clone(&api),
                Arc::clone(&self.shared),
                Arc::clone(&stop),
            );
            inner.running = Some(Running {
                state,
                watcher_stop: stop,
            });
            inner.conflict = None;
            inner.error = None;
            log::info!(
                "vocal: engine running on Voicemeeter strip {} (type {vm_type})",
                mic_strip + 1
            );
            Ok(())
        }

        pub fn stop(&self) {
            let mut inner = self.lock();
            let Some(run) = inner.running.take() else {
                return;
            };
            run.watcher_stop.store(true, Ordering::Release);
            if let Some(api) = inner.api.as_ref() {
                // SAFETY: unregister stops the stream before returning; afterwards the box is ours.
                unsafe { (api.cb_unregister)() };
            }
            drop(unsafe { Box::from_raw(run.state) });
            log::info!("vocal: engine stopped");
        }

        /// Runs a Voicemeeter script (`Strip[0].A1=1; ...`).
        pub fn script(&self, script: &str) -> Result<(), String> {
            let mut inner = self.lock();
            let api = Self::api(&mut inner)?;
            let c = std::ffi::CString::new(script).map_err(|e| e.to_string())?;
            // SAFETY: NUL-terminated script.
            let rep = unsafe { (api.set_parameters)(c.as_ptr()) };
            if rep < 0 {
                Err(format!("VBVMR_SetParameters failed ({rep})"))
            } else {
                Ok(())
            }
        }

        pub fn command(&self, name: &str, value: &str) -> Result<(), String> {
            let mut inner = self.lock();
            let api = Self::api(&mut inner)?;
            let n = std::ffi::CString::new(name).map_err(|e| e.to_string())?;
            let v = std::ffi::CString::new(value).map_err(|e| e.to_string())?;
            // SAFETY: NUL-terminated strings.
            let rep = unsafe { (api.set_string)(n.as_ptr(), v.as_ptr()) };
            if rep < 0 {
                Err(format!("{name} failed ({rep})"))
            } else {
                Ok(())
            }
        }

        /// Device name and label of every strip (`(index, device, label)`).
        /// Voicemeeter's own pre-fader input meters, dBFS per input channel.
        /// Reads one float parameter (`Strip[0].A5`).
        pub fn get_float(&self, name: &str) -> Option<f32> {
            let mut inner = self.lock();
            let api = Self::api(&mut inner).ok()?;
            unsafe { (api.is_dirty)() };
            let n = std::ffi::CString::new(name).ok()?;
            let mut v = 0.0f32;
            // SAFETY: NUL-terminated name, out pointer to a local.
            let rep = unsafe { (api.get_float)(n.as_ptr(), &mut v) };
            (rep == 0).then_some(v)
        }

        pub fn vm_levels(&self) -> Vec<f32> {
            let mut inner = self.lock();
            let Ok(api) = Self::api(&mut inner) else {
                return Vec::new();
            };
            unsafe { (api.is_dirty)() };
            (0..34)
                .map(|ch| {
                    let mut v = 0.0f32;
                    // SAFETY: out pointer to a local; type 0 = input pre-fader.
                    unsafe { (api.get_level)(0, ch, &mut v) };
                    20.0 * v.max(1e-9).log10()
                })
                .collect()
        }

        pub fn strips(&self) -> Result<Vec<(i32, String, String)>, String> {
            let mut inner = self.lock();
            let api = Self::api(&mut inner)?;
            let count = match Self::vm_type(&api) {
                Some(1) => 3,
                Some(2) => 5,
                Some(_) => 8,
                None => return Err("Voicemeeter is not running".into()),
            };
            // Parameters are only fresh after a dirty poll.
            unsafe { (api.is_dirty)() };
            let read = |name: String| -> String {
                let n = std::ffi::CString::new(name).unwrap_or_default();
                let mut buf = [0 as c_char; 512];
                // SAFETY: Voicemeeter writes at most 512 bytes, NUL-terminated.
                let rep = unsafe { (api.get_string)(n.as_ptr(), buf.as_mut_ptr()) };
                if rep != 0 {
                    return String::new();
                }
                unsafe { CStr::from_ptr(buf.as_ptr()) }
                    .to_string_lossy()
                    .into_owned()
            };
            Ok((0..count)
                .map(|i| {
                    (
                        i,
                        read(format!("Strip[{i}].device.name")),
                        read(format!("Strip[{i}].Label")),
                    )
                })
                .collect())
        }

        pub fn shutdown(&self) {
            self.stop();
            let mut inner = self.lock();
            if inner.logged_in
                && let Some(api) = inner.api.as_ref()
            {
                // SAFETY: matching Login.
                unsafe { (api.logout)() };
                inner.logged_in = false;
            }
        }
    }

    /// Restarts the stream after CHANGE and keeps the parameter cache fresh.
    fn spawn_watcher(api: Arc<Api>, shared: Arc<Shared>, stop: Arc<std::sync::atomic::AtomicBool>) {
        let _ = std::thread::Builder::new()
            .name("vocal-watch".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(200));
                    // SAFETY: documented polling call.
                    unsafe { (api.is_dirty)() };
                    if shared.restart.swap(false, Ordering::AcqRel) {
                        log::info!("vocal: Voicemeeter stream changed, restarting");
                        // SAFETY: the callback is still registered.
                        unsafe { (api.cb_start)() };
                    }
                }
            });
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{VocalMeter, VocalStatus};

    #[derive(Default)]
    pub struct VocalCtl;

    impl VocalCtl {
        pub fn status(&self) -> VocalStatus {
            VocalStatus {
                error: Some("Voicemeeter is Windows-only".into()),
                ..VocalStatus::default()
            }
        }
        pub fn meter(&self) -> VocalMeter {
            VocalMeter::default()
        }
        pub fn set_params(&self, _p: tiksee_vocal::VocalParams) {}
        pub fn start(&self, _m: i32, _s: i32) -> Result<(), String> {
            Err("Voicemeeter is Windows-only".into())
        }
        pub fn stop(&self) {}
        pub fn script(&self, _s: &str) -> Result<(), String> {
            Err("Voicemeeter is Windows-only".into())
        }
        pub fn command(&self, _n: &str, _v: &str) -> Result<(), String> {
            Err("Voicemeeter is Windows-only".into())
        }
        pub fn shutdown(&self) {}
        pub fn strips(&self) -> Result<Vec<(i32, String, String)>, String> {
            Err("Voicemeeter is Windows-only".into())
        }
    }
}

/* ------------------------------------------------------------------ *
 * Voicemeeter live preset
 * ------------------------------------------------------------------ */

fn vm_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voicemeeter");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Routing script for singing live (Potato strip numbering, 0-based).
/// Mic and music go to the headphones (`phones` = 1..5 → A1..A5) and the
/// live (B1); TikSee's own voice (AUX) too; VAIO3 stays private (headphones
/// only). Voicemeeter's strip comp/gate is turned off on the mic because
/// TikSee's chain already does it.
pub fn live_script(mic: i32, music: i32, phones: i32) -> String {
    let a = format!("A{}", phones.clamp(1, 5));
    let mut s = format!(
        "Strip[{mic}].{a}=1; Strip[{mic}].B1=1; Strip[{mic}].B2=0; Strip[{mic}].Comp=0; Strip[{mic}].Gate=0; Strip[{mic}].Label=\"Voce TikSee\"; "
    );
    if music >= 0 && music != mic {
        s.push_str(&format!(
            "Strip[{music}].{a}=1; Strip[{music}].B1=1; Strip[{music}].Label=\"Muzica\"; "
        ));
    }
    if mic != 6 && music != 6 {
        s.push_str(&format!(
            "Strip[6].{a}=1; Strip[6].B1=1; Strip[6].Label=\"TikSee\"; "
        ));
    }
    if mic != 7 && music != 7 {
        s.push_str(&format!(
            "Strip[7].{a}=1; Strip[7].B1=0; Strip[7].Label=\"Privat\"; "
        ));
    }
    s.push_str("Bus[5].Mute=0;");
    s
}

#[tauri::command]
pub fn vocal_status(state: tauri::State<'_, VocalCtl>) -> VocalStatus {
    state.status()
}

#[tauri::command]
pub fn vocal_meter(state: tauri::State<'_, VocalCtl>) -> VocalMeter {
    state.meter()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StripInfo {
    pub index: i32,
    pub device: String,
    pub label: String,
}

#[tauri::command]
pub fn vocal_strips(state: tauri::State<'_, VocalCtl>) -> Result<Vec<StripInfo>, String> {
    Ok(state
        .strips()?
        .into_iter()
        .map(|(index, device, label)| StripInfo {
            index,
            device,
            label,
        })
        .collect())
}

#[tauri::command]
pub fn vocal_start(
    state: tauri::State<'_, VocalCtl>,
    mic_strip: i32,
    music_strip: i32,
) -> Result<(), String> {
    state.start(mic_strip, music_strip)
}

#[tauri::command]
pub fn vocal_stop(state: tauri::State<'_, VocalCtl>) {
    state.stop();
}

#[tauri::command]
pub fn vocal_set_params(
    state: tauri::State<'_, VocalCtl>,
    params: serde_json::Value,
) -> Result<(), String> {
    let p: VocalParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    state.set_params(p);
    Ok(())
}

/// EQ + HPF response in dB at 96 log-spaced points 20 Hz–20 kHz.
#[tauri::command]
pub fn vocal_eq_curve(chain: serde_json::Value) -> Result<Vec<f32>, String> {
    let chain: tiksee_vocal::params::Chain =
        serde_json::from_value(chain).map_err(|e| e.to_string())?;
    let freqs: Vec<f32> = (0..96)
        .map(|i| 20.0 * 1000f32.powf(i as f32 / 95.0))
        .collect();
    Ok(Engine::chain_curve(&chain, 48_000.0, &freqs))
}

/// Saves the current Voicemeeter configuration; returns the file path.
#[tauri::command]
pub fn vm_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, VocalCtl>,
) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = vm_dir(&app)?.join(format!("backup-{stamp}.xml"));
    let p = path.display().to_string();
    state.command("Command.Save", &p)?;
    Ok(p)
}

/// Backs up first, then applies the live routing. Returns the backup path.
#[tauri::command]
pub fn vm_apply_live(
    app: tauri::AppHandle,
    state: tauri::State<'_, VocalCtl>,
    mic_strip: i32,
    music_strip: i32,
    phones_bus: i32,
) -> Result<String, String> {
    let backup = vm_backup(app, state.clone())?;
    state.script(&live_script(mic_strip, music_strip, phones_bus))?;
    Ok(backup)
}

/// Loads the newest backup (or `path`).
#[tauri::command]
pub fn vm_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, VocalCtl>,
    path: Option<String>,
) -> Result<String, String> {
    let path = match path {
        Some(p) => p,
        None => {
            let mut files: Vec<_> = std::fs::read_dir(vm_dir(&app)?)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "xml"))
                .collect();
            files.sort();
            files
                .pop()
                .ok_or("no Voicemeeter backup yet")?
                .display()
                .to_string()
        }
    };
    state.command("Command.Load", &path)?;
    Ok(path)
}

/// Live check without the UI: run the engine on `strip` for `secs` and print status/meters.
pub fn probe(strip: i32, secs: u64, monitor_bus: Option<i32>) {
    let ctl = VocalCtl::default();
    println!("status before: {:?}", ctl.status());
    for (i, dev, label) in ctl.strips().unwrap_or_default() {
        println!("strip {}: device='{dev}' label='{label}'", i + 1);
    }
    let routes: Vec<String> = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"]
        .iter()
        .filter(|b| {
            ctl.get_float(&format!("Strip[{strip}].{b}"))
                .is_some_and(|v| v > 0.5)
        })
        .map(|b| (*b).to_owned())
        .collect();
    println!("strip {} routed to: {}", strip + 1, routes.join(" "));
    // Audible test: hard tune in C major.
    let mut params = VocalParams::default();
    params.tune.scale = tiksee_vocal::scale::Scale::Major;
    params.tune.retune_ms = 0.0;
    params.tune.humanize = 0.0;
    params.tune.vibrato = 0.0;
    ctl.set_params(params);
    // Temporarily route the strip to the headphones; restored at the end.
    let monitor = monitor_bus.map(|b| format!("Strip[{strip}].A{}", b.clamp(1, 5)));
    let was = monitor.as_deref().and_then(|m| ctl.get_float(m));
    if let Some(m) = monitor.as_deref() {
        let _ = ctl.script(&format!("{m}=1;"));
        println!("monitoring on {m} (was {was:?})");
    }
    match ctl.start(strip, -1) {
        Ok(()) => println!("started on strip {}", strip + 1),
        Err(e) => {
            println!("start failed: {e}");
            return;
        }
    }
    for _ in 0..secs * 2 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let s = ctl.status();
        let loud: Vec<String> = s
            .channel_peaks_db
            .iter()
            .enumerate()
            .filter(|(_, d)| **d > -150.0)
            .map(|(c, d)| format!("ch{c}={d:.0}"))
            .collect();
        println!("peaks: {}", loud.join(" "));
        let vm: Vec<String> = ctl
            .vm_levels()
            .iter()
            .enumerate()
            .filter(|(_, d)| **d > -150.0)
            .map(|(c, d)| format!("ch{c}={d:.0}"))
            .collect();
        println!("vm levels: {}", vm.join(" "));
        let m = ctl.meter().meter;
        println!(
            "cb={} sr={} block={} in={:.1} dB out={:.1} dB midi={:.2}->{:.2} voiced={} lat={:.2} ms",
            s.callbacks,
            s.sample_rate,
            s.block,
            m.input_db,
            m.output_db,
            m.detected_midi,
            m.corrected_midi,
            m.voiced,
            m.latency_ms
        );
    }
    ctl.stop();
    if let (Some(m), Some(v)) = (monitor.as_deref(), was) {
        let _ = ctl.script(&format!("{m}={};", if v > 0.5 { 1 } else { 0 }));
        println!("restored {m}={v}");
    }
    // Voicemeeter applies scripts asynchronously; logging out at once drops them.
    std::thread::sleep(std::time::Duration::from_millis(400));
    ctl.shutdown();
    println!("stopped");
}

/// Runs one Voicemeeter script and waits for it to apply (probe repair mode).
pub fn run_script(script: &str) {
    let ctl = VocalCtl::default();
    // First call logs in; Voicemeeter needs a moment before it accepts parameters.
    let _ = ctl.status();
    std::thread::sleep(std::time::Duration::from_millis(300));
    match ctl.script(script) {
        Ok(()) => println!("script ok: {script}"),
        Err(e) => println!("script failed: {e}"),
    }
    std::thread::sleep(std::time::Duration::from_millis(400));
    ctl.shutdown();
}

pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.manage(VocalCtl::default());
}

pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(ctl) = app.try_state::<VocalCtl>() {
        ctl.shutdown();
    }
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn is<T: Send + Sync>() {}
    is::<Arc<Shared>>();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potato_strip_layout_matches_the_sdk() {
        assert_eq!(strip_channels(3, 0), Some((0, 2)));
        assert_eq!(strip_channels(3, 4), Some((8, 2)));
        assert_eq!(strip_channels(3, 5), Some((10, 8)));
        assert_eq!(strip_channels(3, 7), Some((26, 8)));
        assert_eq!(strip_channels(3, 8), None);
        assert_eq!(strip_channels(2, 3), Some((6, 8)));
        assert_eq!(strip_channels(1, 2), Some((4, 8)));
    }

    #[test]
    fn live_script_routes_mic_and_music() {
        let s = live_script(0, 5, 5);
        assert!(s.contains("Strip[0].A5=1; Strip[0].B1=1;"));
        assert!(s.contains("Strip[5].A5=1; Strip[5].B1=1;"));
        assert!(s.contains("Strip[7].A5=1; Strip[7].B1=0;"));
        assert!(!s.contains(".A1="));
    }

    #[test]
    fn dsp_processes_a_buffer_in_place() {
        let shared = Shared::default();
        shared.vm_type.store(3, Ordering::Relaxed);
        shared.mic_strip.store(0, Ordering::Relaxed);
        shared.music_strip.store(5, Ordering::Relaxed);
        let mut dsp = Dsp::new(48_000.0, &shared);
        let nbs = 256;
        let mut chans: Vec<Vec<f32>> = (0..34).map(|c| vec![0.1 * c as f32; nbs]).collect();
        for (i, v) in chans[0].iter_mut().enumerate() {
            *v = (i as f32 * 0.05).sin() * 0.3;
        }
        let ptrs: Vec<*mut f32> = chans.iter_mut().map(|c| c.as_mut_ptr()).collect();
        for _ in 0..50 {
            // SAFETY: each pointer is valid for nbs floats (in-place insert, r == w).
            unsafe { dsp.process(&shared, &ptrs, &ptrs, nbs) };
        }
        assert!(
            chans[0]
                .iter()
                .chain(chans[1].iter())
                .all(|v| v.is_finite())
        );
        assert!((chans[12][0] - 1.2).abs() < 1e-6, "untouched strip changed");
        assert!(shared.meter.lock().unwrap().input_db > -60.0);
    }
}
