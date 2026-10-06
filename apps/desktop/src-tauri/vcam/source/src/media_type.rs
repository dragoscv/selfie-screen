//! Media Foundation media types for the formats in [`crate::formats`].

use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MFCreateMediaType,
    MFMediaType_Video, MFNominalRange_16_235, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFVideoPrimaries_BT709,
    MFVideoTransFunc_709, MFVideoTransferMatrix_BT709,
};
use windows_core::Result;

use crate::formats::{Format, pack};

/// NV12, progressive, square pixels, BT.709 limited range (what
/// `tiksee_vcam_shared::nv12` produces).
pub(crate) fn create(format: Format) -> Result<IMFMediaType> {
    // SAFETY: plain attribute writes on a fresh media type.
    unsafe {
        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(format.width, format.height))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack(format.fps, 1))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        media_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, format.width)?;
        media_type.SetUINT32(&MF_MT_AVG_BITRATE, format.bitrate())?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        Ok(media_type)
    }
}

/// Reads back the format a consumer negotiated.
pub(crate) fn format_of(media_type: &IMFMediaType) -> Option<Format> {
    // SAFETY: attribute reads.
    unsafe {
        let subtype = media_type.GetGUID(&MF_MT_SUBTYPE).ok()?;
        if subtype != MFVideoFormat_NV12 {
            return None;
        }
        let size = media_type.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
        let rate = media_type.GetUINT64(&MF_MT_FRAME_RATE).ok()?;
        Format::from_packed(size, rate)
    }
}
