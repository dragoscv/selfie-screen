//! Named shared-memory section that carries the frame ring between the app
//! (interactive session) and the media source (Frame Server, session 0,
//! LocalService).
//!
//! Creating a `Global\` object from a user session needs
//! SeCreateGlobalPrivilege, which a non-elevated app does not hold, while
//! LocalService does. So the media source creates the section when a
//! consumer starts streaming, and the app opens it; an elevated app may
//! create it itself. Either side applies the same DACL, which lets both
//! LocalService and the interactive user map it read/write.

use windows::Win32::Foundation::{
    CloseHandle, E_ACCESSDENIED, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
};
use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP, FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    OpenFileMappingW, PAGE_READWRITE, UnmapViewOfFile,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::core::{HSTRING, Result};

use crate::layout::{MAPPING_BYTES, OutputConfig, Ring};

/// SYSTEM, LocalService and Administrators: full access; interactive users
/// (the streamer's own session): read and write. Protected from inheritance.
pub const SECTION_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GRGW;;;IU)";

/// Milliseconds since boot. One clock for every session, so the producer's
/// heartbeat and the consumer's staleness check agree.
pub fn tick_ms() -> u64 {
    // SAFETY: no preconditions.
    unsafe { GetTickCount64() }
}

pub struct Section {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    ring: Ring,
    created: bool,
}

const VIEW_ACCESS: FILE_MAP = FILE_MAP(FILE_MAP_READ.0 | FILE_MAP_WRITE.0);

impl Section {
    /// Opens an existing section. Fails with `ERROR_FILE_NOT_FOUND` when the
    /// other side has not created it yet.
    pub fn open(name: &str) -> Result<Self> {
        // SAFETY: plain Win32 call with a valid, NUL-terminated name.
        let handle = unsafe { OpenFileMappingW(VIEW_ACCESS.0, false, &HSTRING::from(name))? };
        Self::map(handle, false)
    }

    /// Creates the section (or opens it when it already exists) and
    /// initialises the ring when this call created it.
    pub fn create(name: &str, config: OutputConfig) -> Result<Self> {
        let descriptor = SecurityDescriptor::from_sddl(SECTION_SDDL)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let size = MAPPING_BYTES as u64;
        // SAFETY: attributes and name outlive the call; INVALID_HANDLE_VALUE
        // asks for a pagefile-backed section.
        let handle = match unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                Some(&attributes),
                PAGE_READWRITE,
                (size >> 32) as u32,
                size as u32,
                &HSTRING::from(name),
            )
        } {
            Ok(handle) => handle,
            // An existing section grants the interactive user read/write
            // only, not the full access CreateFileMappingW asks for.
            Err(error) if error.code() == E_ACCESSDENIED => return Self::open(name),
            Err(error) => return Err(error),
        };
        // SAFETY: reads the thread's last error right after the call.
        let created = unsafe { GetLastError() } != ERROR_ALREADY_EXISTS;
        let section = Self::map(handle, created)?;
        if created {
            section.ring.initialize(config);
        }
        Ok(section)
    }

    pub fn open_or_create(name: &str, config: OutputConfig) -> Result<Self> {
        Self::open(name).or_else(|_| Self::create(name, config))
    }

    fn map(handle: HANDLE, created: bool) -> Result<Self> {
        // SAFETY: handle is a live section handle owned by this function.
        let view = unsafe { MapViewOfFile(handle, VIEW_ACCESS, 0, 0, MAPPING_BYTES) };
        let mapped = (!view.Value.is_null())
            .then(|| {
                // SAFETY: the view is MAPPING_BYTES long, page aligned and
                // lives until Drop unmaps it.
                unsafe { Ring::from_raw(view.Value.cast()) }
            })
            .flatten();
        match mapped {
            Some(ring) => Ok(Self {
                handle,
                view,
                ring,
                created,
            }),
            None => {
                let error = windows::core::Error::from_thread();
                // SAFETY: closing the handle we own on the failure path.
                unsafe {
                    let _ = CloseHandle(handle);
                }
                Err(error)
            }
        }
    }

    pub fn ring(&self) -> Ring {
        self.ring
    }

    /// Whether this handle created the section (and initialised the ring).
    pub fn created(&self) -> bool {
        self.created
    }
}

impl Drop for Section {
    fn drop(&mut self) {
        // SAFETY: view and handle came from MapViewOfFile / Create/OpenFileMapping.
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.handle);
        }
    }
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn from_sddl(sddl: &str) -> Result<Self> {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the out pointer is valid; the result is freed in Drop.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )?;
        }
        Ok(Self(descriptor))
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Orientation;

    fn unique(tag: &str) -> String {
        format!("Local\\TikSeeVcamTest-{tag}-{}", std::process::id())
    }

    #[test]
    fn sddl_parses() {
        assert!(SecurityDescriptor::from_sddl(SECTION_SDDL).is_ok());
    }

    #[test]
    fn open_fails_until_someone_creates_the_section() {
        assert!(Section::open(&unique("missing")).is_err());
    }

    #[test]
    fn creator_initialises_and_opener_sees_the_same_ring() {
        let name = unique("shared");
        let portrait = OutputConfig::new(Orientation::Portrait, 60).unwrap();
        let creator = Section::create(&name, portrait).expect("create");
        assert!(creator.created());
        let opener = Section::open(&name).expect("open");
        assert!(!opener.created());
        assert_eq!(opener.ring().requested(), Some(portrait));

        let now = tick_ms();
        let seq = creator
            .ring()
            .publish_with(4, 2, now, |px| {
                px.fill(42);
                Ok::<(), crate::FrameError>(())
            })
            .expect("publish");
        let mut dst = vec![0; 12];
        let info = opener.ring().read_latest(&mut dst, now).expect("frame");
        assert_eq!(info.seq, seq);
        assert_eq!(dst, vec![42; 12]);

        // A second create maps the existing section instead of resetting it.
        let again = Section::create(&name, OutputConfig::default()).expect("reopen");
        assert!(!again.created());
        assert_eq!(again.ring().requested(), Some(portrait));
    }

    #[test]
    fn open_or_create_falls_back_to_create() {
        let section = Section::open_or_create(&unique("either"), OutputConfig::default()).expect("section");
        assert!(section.created());
        assert!(section.ring().is_initialized());
    }

    #[test]
    fn tick_clock_moves_forward() {
        let a = tick_ms();
        let b = tick_ms();
        assert!(b >= a && a > 0);
    }
}
