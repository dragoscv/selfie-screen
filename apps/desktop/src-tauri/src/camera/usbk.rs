//! USB transport for Sony cameras in PC Remote mode on Windows.
//!
//! Sony's "srcameradriver" binds the camera (054c:0d97 on ZV-E10) to
//! libusbK.sys and installs libusbK.dll. libusb and libusbK's own device list
//! do not see it (its INF registers a malformed multi-GUID list), so the
//! device is opened by its libusbK interface path with CreateFileW and handed
//! to UsbK_Initialize. Loaded dynamically: no Sony driver, no camera control,
//! and the rest of TikSee is unaffected.
use std::ffi::c_void;
use std::time::Duration;

use libloading::{Library, Symbol};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, SP_DEVICE_INTERFACE_DATA,
    SP_DEVICE_INTERFACE_DETAIL_DATA_W, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces,
    SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW,
};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::core::{GUID, PCWSTR};

/// libusbK device-interface class.
const LIBUSBK_GUID: GUID = GUID::from_u128(0x6c696275_7362_2d77_696e_33322d574446);
const PIPE_TRANSFER_TIMEOUT: u32 = 0x03;

type Bool = i32;
type H = *mut c_void;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct PipeInfo {
    pipe_type: u32,
    pipe_id: u8,
    max_packet: u16,
    interval: u8,
}

pub struct UsbDevice {
    lib: Library,
    handle: H,
    file: HANDLE,
    pub bulk_out: u8,
    pub bulk_in: u8,
    pub interrupt_in: u8,
}

// The handle is only ever used from the camera worker thread.
unsafe impl Send for UsbDevice {}

/// Interface paths of present libusbK devices whose path contains `needle`
/// (case-insensitive), e.g. "vid_054c&pid_0d97".
pub fn find_paths(needle: &str) -> Vec<String> {
    let needle = needle.to_lowercase();
    let mut out = Vec::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(
            Some(&LIBUSBK_GUID),
            PCWSTR::null(),
            None,
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        ) else {
            return out;
        };
        let mut i = 0;
        loop {
            let mut data = SP_DEVICE_INTERFACE_DATA {
                cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInterfaces(set, None, &LIBUSBK_GUID, i, &mut data).is_err() {
                break;
            }
            i += 1;
            let mut need = 0u32;
            let _ = SetupDiGetDeviceInterfaceDetailW(set, &data, None, 0, Some(&mut need), None);
            if need == 0 {
                continue;
            }
            let mut buf = vec![0u8; need as usize];
            let detail = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            if SetupDiGetDeviceInterfaceDetailW(set, &data, Some(detail), need, None, None).is_ok()
            {
                let p = std::ptr::addr_of!((*detail).DevicePath) as *const u16;
                let len = (0..).take_while(|&k| *p.add(k) != 0).count();
                let path = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
                if path.to_lowercase().contains(&needle) {
                    out.push(path);
                }
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    out
}

impl UsbDevice {
    pub fn open(path: &str, timeout: Duration) -> Result<Self, String> {
        unsafe {
            let lib = Library::new("libusbK.dll").map_err(|e| {
                format!("libusbK.dll not available (Sony camera driver missing?): {e}")
            })?;
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let file = CreateFileW(
                PCWSTR(wide.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            )
            .map_err(|e| format!("open {path}: {e}"))?;
            let init: Symbol<unsafe extern "system" fn(HANDLE, *mut H) -> Bool> =
                lib.get(b"UsbK_Initialize").map_err(|e| e.to_string())?;
            let mut handle: H = std::ptr::null_mut();
            if init(file, &mut handle) == 0 {
                let err = std::io::Error::last_os_error();
                let _ = CloseHandle(file);
                return Err(format!("UsbK_Initialize: {err}"));
            }
            let mut dev = Self {
                lib,
                handle,
                file,
                bulk_out: 0,
                bulk_in: 0,
                interrupt_in: 0,
            };
            let claim: Symbol<unsafe extern "system" fn(H, u8, Bool) -> Bool> = dev
                .lib
                .get(b"UsbK_ClaimInterface")
                .map_err(|e| e.to_string())?;
            if claim(handle, 0, 0) == 0 {
                return Err(format!(
                    "claim interface: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let query: Symbol<unsafe extern "system" fn(H, u8, u8, *mut PipeInfo) -> Bool> =
                dev.lib.get(b"UsbK_QueryPipe").map_err(|e| e.to_string())?;
            for idx in 0..8u8 {
                let mut p = PipeInfo::default();
                if query(handle, 0, idx, &mut p) == 0 {
                    break;
                }
                match (p.pipe_type, p.pipe_id & 0x80 != 0) {
                    (2, false) => dev.bulk_out = p.pipe_id,
                    (2, true) => dev.bulk_in = p.pipe_id,
                    (3, true) => dev.interrupt_in = p.pipe_id,
                    _ => {}
                }
            }
            if dev.bulk_out == 0 || dev.bulk_in == 0 {
                return Err("camera has no PTP bulk endpoints (is PC Remote = USB on?)".into());
            }
            let ms = timeout.as_millis() as u32;
            dev.set_timeout(dev.bulk_out, ms);
            dev.set_timeout(dev.bulk_in, ms);
            Ok(dev)
        }
    }

    fn set_timeout(&self, pipe: u8, ms: u32) {
        unsafe {
            if let Ok(f) = self
                .lib
                .get::<unsafe extern "system" fn(H, u8, u32, u32, *const c_void) -> Bool>(
                    b"UsbK_SetPipePolicy",
                )
            {
                f(
                    self.handle,
                    pipe,
                    PIPE_TRANSFER_TIMEOUT,
                    4,
                    &ms as *const u32 as *const c_void,
                );
            }
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        unsafe {
            let f: Symbol<
                unsafe extern "system" fn(H, u8, *const u8, u32, *mut u32, *mut c_void) -> Bool,
            > = self.lib.get(b"UsbK_WritePipe").map_err(|e| e.to_string())?;
            let mut n = 0u32;
            if f(
                self.handle,
                self.bulk_out,
                data.as_ptr(),
                data.len() as u32,
                &mut n,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(format!("usb write: {}", std::io::Error::last_os_error()));
            }
        }
        Ok(())
    }

    pub fn read(&self, buf: &mut [u8]) -> Result<usize, String> {
        unsafe {
            let f: Symbol<
                unsafe extern "system" fn(H, u8, *mut u8, u32, *mut u32, *mut c_void) -> Bool,
            > = self.lib.get(b"UsbK_ReadPipe").map_err(|e| e.to_string())?;
            let mut n = 0u32;
            if f(
                self.handle,
                self.bulk_in,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut n,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(format!("usb read: {}", std::io::Error::last_os_error()));
            }
            Ok(n as usize)
        }
    }
}

impl Drop for UsbDevice {
    fn drop(&mut self) {
        unsafe {
            if let Ok(f) = self
                .lib
                .get::<unsafe extern "system" fn(H) -> Bool>(b"UsbK_Free")
            {
                f(self.handle);
            }
            let _ = CloseHandle(self.file);
        }
    }
}
