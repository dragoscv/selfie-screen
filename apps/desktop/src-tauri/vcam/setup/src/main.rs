//! `tiksee-vcam-setup.exe install | uninstall | status`
//!
//! Registers "TikSee Camera" system-wide: COM-registers `tiksee_vcam.dll`
//! (next to this exe) under HKLM, then creates the virtual camera with
//! `MFCreateVirtualCamera` (System lifetime, all users). Needs an elevated
//! token; the NSIS installer runs it hidden via nsExec, the app via `runas`.
//!
//! Exit codes: 0 ok, 2 not elevated, 1 anything else (HRESULT printed).

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use std::process::ExitCode;

    use tiksee_vcam_shared::layout::{CLSID_STRING, FRIENDLY_NAME, clsid_key};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::Media::MediaFoundation::{
        IMFVirtualCamera, MF_VERSION, MFCreateVirtualCamera, MFSTARTUP_FULL, MFShutdown, MFStartup,
        MFVirtualCameraAccess_AllUsers, MFVirtualCameraLifetime_System, MFVirtualCameraType_SoftwareCameraSource,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::Win32::UI::Shell::IsUserAnAdmin;
    use windows_core::{HRESULT, HSTRING, PCSTR, PCWSTR, Result, s};

    pub const DLL_NAME: &str = "tiksee_vcam.dll";

    enum Failure {
        NotElevated,
        Error(&'static str, windows_core::Error),
    }

    fn step<T>(what: &'static str, result: Result<T>) -> std::result::Result<T, Failure> {
        result.map_err(|error| Failure::Error(what, error))
    }

    fn dll_path() -> Result<PathBuf> {
        let exe = std::env::current_exe().map_err(windows_core::Error::from)?;
        Ok(exe.with_file_name(DLL_NAME))
    }

    /// `regsvr32`-equivalent: load the DLL and call one of its exports.
    fn call_export(name: PCSTR) -> Result<()> {
        let path = dll_path()?;
        // SAFETY: loading our own DLL; the export has the documented
        // `HRESULT (STDAPICALLTYPE *)(void)` signature.
        unsafe {
            let module = LoadLibraryW(&HSTRING::from(path.as_os_str()))?;
            let result = match GetProcAddress(module, name) {
                Some(proc) => {
                    let export: extern "system" fn() -> HRESULT = std::mem::transmute(proc);
                    export().ok()
                }
                None => Err(windows_core::Error::from_thread()),
            };
            let _ = FreeLibrary(module);
            result
        }
    }

    /// Runs `f` between MFStartup and MFShutdown on an MTA thread.
    fn with_mf<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
        // SAFETY: balanced init / uninit on this thread.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let result = MFStartup(MF_VERSION, MFSTARTUP_FULL).and_then(|()| {
                let result = f();
                let _ = MFShutdown();
                result
            });
            CoUninitialize();
            result
        }
    }

    fn virtual_camera() -> Result<IMFVirtualCamera> {
        // SAFETY: plain factory call with static strings.
        unsafe {
            MFCreateVirtualCamera(
                MFVirtualCameraType_SoftwareCameraSource,
                MFVirtualCameraLifetime_System,
                MFVirtualCameraAccess_AllUsers,
                &HSTRING::from(FRIENDLY_NAME),
                &HSTRING::from(CLSID_STRING),
                None,
            )
        }
    }

    fn require_admin() -> std::result::Result<(), Failure> {
        // SAFETY: no preconditions.
        if unsafe { IsUserAnAdmin() }.as_bool() {
            Ok(())
        } else {
            Err(Failure::NotElevated)
        }
    }

    fn install() -> std::result::Result<(), Failure> {
        require_admin()?;
        step("DllRegisterServer", call_export(s!("DllRegisterServer")))?;
        step(
            "MFCreateVirtualCamera",
            with_mf(|| {
                let camera = virtual_camera()?;
                // SAFETY: live camera object.
                unsafe {
                    camera.Start(None)?;
                    camera.Shutdown()
                }
            }),
        )?;
        println!("installed: {FRIENDLY_NAME} {CLSID_STRING}");
        Ok(())
    }

    fn uninstall() -> std::result::Result<(), Failure> {
        require_admin()?;
        let removed = with_mf(|| {
            let camera = virtual_camera()?;
            // SAFETY: live camera object.
            unsafe {
                let result = camera.Remove();
                let _ = camera.Shutdown();
                result
            }
        });
        if let Err(error) = &removed {
            // Keep going: the COM class must go even if the camera is gone.
            println!("virtual camera remove: {:#010x} {}", error.code().0, error.message());
        }
        step("DllUnregisterServer", call_export(s!("DllUnregisterServer")))?;
        println!("uninstalled");
        Ok(())
    }

    /// `HKLM\...\CLSID\{...}\InprocServer32` default value, if present.
    pub fn registered_dll() -> Option<String> {
        let key = HSTRING::from(format!("{}\\InprocServer32", clsid_key()));
        let mut size = 0u32;
        // SAFETY: size query, then a read into a buffer of that size.
        unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                &key,
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&raw mut size),
            )
            .ok()
            .ok()?;
            let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                &key,
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&raw mut size),
            )
            .ok()
            .ok()?;
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..len]))
        }
    }

    fn status() -> std::result::Result<(), Failure> {
        match registered_dll() {
            Some(path) => {
                let exists = std::path::Path::new(&path).exists();
                println!(
                    "registered: {path} (file {})",
                    if exists { "present" } else { "MISSING" }
                );
            }
            None => println!("not registered"),
        }
        Ok(())
    }

    fn usage() -> ExitCode {
        eprintln!("usage: tiksee-vcam-setup install | uninstall | status");
        ExitCode::from(1)
    }

    pub fn main() -> ExitCode {
        let Some(command) = std::env::args().nth(1) else {
            return usage();
        };
        let result = match command.as_str() {
            "install" => install(),
            "uninstall" => uninstall(),
            "status" => status(),
            _ => return usage(),
        };
        match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(Failure::NotElevated) => {
                eprintln!("{command}: administrator rights required");
                ExitCode::from(2)
            }
            Err(Failure::Error(what, error)) => {
                eprintln!("{command}: {what} failed: {:#010x} {}", error.code().0, error.message());
                ExitCode::from(1)
            }
        }
    }
}

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    imp::main()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("tiksee-vcam-setup only runs on Windows");
    std::process::exit(1);
}
