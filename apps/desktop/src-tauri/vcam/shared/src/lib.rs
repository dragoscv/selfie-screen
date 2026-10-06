//! TikSee Camera plumbing shared by the app (frame producer) and the media
//! source DLL loaded by the Windows Camera Frame Server (frame consumer).
//!
//! Everything both sides must agree on lives here so a layout change breaks
//! both at compile time: the shared-memory ring, the pixel conversions, the
//! source CLSID and the "camera offline" placeholder frame.

pub mod layout;
pub mod nv12;
pub mod offline;

#[cfg(windows)]
pub mod win;

pub use layout::{FrameError, FrameInfo, Orientation, OutputConfig, Ring};
