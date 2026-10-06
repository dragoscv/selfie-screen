//! RGBA -> NV12 (BT.709, limited range) and pitched plane copies.
//!
//! BT.709 limited range is what every webcam pipeline assumes for HD NV12,
//! and the media type advertises it explicitly, so consumers never guess.
//! Coefficients are the standard ones in 8.8 fixed point; each chroma row is
//! zero-sum so neutral greys map exactly to 128.

use crate::layout::{FrameError, check_dims, nv12_len};

#[inline]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8
}

#[inline]
fn chroma(r: i32, g: i32, b: i32) -> (u8, u8) {
    let u = ((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
    (u.clamp(16, 240) as u8, v.clamp(16, 240) as u8)
}

/// One RGB colour as limited-range BT.709 `(Y, U, V)`.
pub fn yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (r, g, b) = (i32::from(r), i32::from(g), i32::from(b));
    let (u, v) = chroma(r, g, b);
    (luma(r, g, b), u, v)
}

/// Converts tightly packed RGBA (alpha ignored: the canvas is opaque) into a
/// tightly packed NV12 frame. Chroma is the average of each 2x2 block.
pub fn rgba_to_nv12(rgba: &[u8], width: u32, height: u32, out: &mut [u8]) -> Result<(), FrameError> {
    check_dims(width, height)?;
    let (w, h) = (width as usize, height as usize);
    if rgba.len() != w * h * 4 {
        return Err(FrameError::WrongLength {
            expected: w * h * 4,
            actual: rgba.len(),
        });
    }
    if out.len() != nv12_len(width, height) {
        return Err(FrameError::WrongLength {
            expected: nv12_len(width, height),
            actual: out.len(),
        });
    }
    let (y_plane, uv_plane) = out.split_at_mut(w * h);
    let row_bytes = w * 4;
    for (pair, uv_row) in uv_plane.chunks_exact_mut(w).enumerate() {
        let top = &rgba[2 * pair * row_bytes..][..row_bytes];
        let bottom = &rgba[(2 * pair + 1) * row_bytes..][..row_bytes];
        let (y_top, y_bottom) = y_plane[2 * pair * w..][..2 * w].split_at_mut(w);
        for (x, uv) in uv_row.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let mut sum = [0i32; 3];
            for (row, y_row) in [(top, &mut *y_top), (bottom, &mut *y_bottom)] {
                for dx in 0..2 {
                    let px = &row[(2 * x + dx) * 4..][..3];
                    let (r, g, b) = (i32::from(px[0]), i32::from(px[1]), i32::from(px[2]));
                    y_row[2 * x + dx] = luma(r, g, b);
                    sum[0] += r;
                    sum[1] += g;
                    sum[2] += b;
                }
            }
            let (u, v) = chroma((sum[0] + 2) >> 2, (sum[1] + 2) >> 2, (sum[2] + 2) >> 2);
            uv[0] = u;
            uv[1] = v;
        }
    }
    Ok(())
}

/// Copies a tight NV12 frame into a buffer whose rows are `pitch` bytes apart
/// and whose UV plane starts at `pitch * height` (the Media Foundation 2D
/// buffer layout).
pub fn copy_nv12_pitched(src: &[u8], width: u32, height: u32, dst: &mut [u8], pitch: usize) -> Result<(), FrameError> {
    check_dims(width, height)?;
    let (w, h) = (width as usize, height as usize);
    let expected = nv12_len(width, height);
    if src.len() != expected {
        return Err(FrameError::WrongLength {
            expected,
            actual: src.len(),
        });
    }
    let needed = pitch * (h + h / 2);
    if pitch < w || dst.len() < needed {
        return Err(FrameError::WrongLength {
            expected: needed.max(expected),
            actual: dst.len(),
        });
    }
    for (src_row, dst_row) in src.chunks_exact(w).zip(dst.chunks_mut(pitch)) {
        dst_row[..w].copy_from_slice(src_row);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        (0..width * height)
            .flat_map(|_| [rgb[0], rgb[1], rgb[2], 255])
            .collect()
    }

    fn convert(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![0; nv12_len(width, height)];
        rgba_to_nv12(rgba, width, height, &mut out).expect("convert");
        out
    }

    #[test]
    fn reference_colours_match_bt709_limited_range() {
        // (rgb, Y, U, V) from the BT.709 spec, +-1 for fixed-point rounding.
        let cases = [
            ([0, 0, 0], 16, 128, 128),
            ([255, 255, 255], 235, 128, 128),
            ([128, 128, 128], 126, 128, 128),
            ([255, 0, 0], 63, 102, 240),
            ([0, 255, 0], 173, 42, 26),
            ([0, 0, 255], 32, 240, 118),
        ];
        for (rgb, y, u, v) in cases {
            let (gy, gu, gv) = yuv(rgb[0], rgb[1], rgb[2]);
            for (got, want, name) in [(gy, y, "Y"), (gu, u, "U"), (gv, v, "V")] {
                assert!(
                    (i32::from(got) - want).abs() <= 1,
                    "{rgb:?} {name}: got {got}, want {want}"
                );
            }
        }
    }

    #[test]
    fn solid_frame_has_uniform_planes() {
        let (w, h) = (6, 4);
        let out = convert(&solid(w, h, [255, 0, 0]), w, h);
        let (y_plane, uv) = out.split_at((w * h) as usize);
        let (ry, ru, rv) = yuv(255, 0, 0);
        assert!(y_plane.iter().all(|&y| y == ry));
        assert_eq!(uv.len(), (w * h / 2) as usize);
        assert!(uv.as_chunks::<2>().0.iter().all(|p| *p == [ru, rv]));
    }

    #[test]
    fn chroma_is_the_average_of_each_2x2_block() {
        // 2x2: two white and two black pixels -> mid grey chroma (neutral).
        let rgba = [
            255, 255, 255, 255, 0, 0, 0, 255, //
            0, 0, 0, 255, 255, 255, 255, 255,
        ];
        let out = convert(&rgba, 2, 2);
        assert_eq!(&out[..4], &[235, 16, 16, 235]);
        assert_eq!(&out[4..], &[128, 128]);

        // Red on the left column, blue on the right: chroma of the average.
        let rgba = [255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 0];
        let out = convert(&rgba, 2, 2);
        let (_, u, v) = yuv(128, 0, 128);
        assert_eq!(&out[4..], &[u, v]);
    }

    #[test]
    fn planes_are_laid_out_row_major_with_interleaved_uv() {
        // 4x2 frame: left 2x2 block red, right block blue.
        let mut rgba = Vec::new();
        for _ in 0..2 {
            rgba.extend_from_slice(&[255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
        }
        let out = convert(&rgba, 4, 2);
        let (ry, ru, rv) = yuv(255, 0, 0);
        let (by, bu, bv) = yuv(0, 0, 255);
        assert_eq!(&out[..8], &[ry, ry, by, by, ry, ry, by, by]);
        assert_eq!(&out[8..], &[ru, rv, bu, bv]);
    }

    #[test]
    fn alpha_is_ignored() {
        let opaque = convert(&solid(2, 2, [10, 200, 30]), 2, 2);
        let mut clear = solid(2, 2, [10, 200, 30]);
        clear.iter_mut().skip(3).step_by(4).for_each(|a| *a = 0);
        assert_eq!(convert(&clear, 2, 2), opaque);
    }

    #[test]
    fn wrong_sizes_are_errors_not_panics() {
        let mut out = vec![0; nv12_len(4, 2)];
        assert!(rgba_to_nv12(&[0; 31], 4, 2, &mut out).is_err());
        assert!(rgba_to_nv12(&[0; 32], 4, 2, &mut out[..11]).is_err());
        assert!(rgba_to_nv12(&[0; 24], 3, 2, &mut out).is_err());
    }

    #[test]
    fn pitched_copy_places_both_planes() {
        let (w, h, pitch) = (4u32, 2u32, 8usize);
        let src: Vec<u8> = (1..=12).collect();
        let mut dst = vec![0xAA; pitch * 3];
        copy_nv12_pitched(&src, w, h, &mut dst, pitch).expect("copy");
        assert_eq!(&dst[0..4], &[1, 2, 3, 4]);
        assert_eq!(&dst[4..8], &[0xAA; 4], "padding untouched");
        assert_eq!(&dst[8..12], &[5, 6, 7, 8]);
        assert_eq!(&dst[16..20], &[9, 10, 11, 12], "UV plane at pitch*height");
        assert!(copy_nv12_pitched(&src, w, h, &mut dst, 3).is_err(), "pitch < width");
        assert!(
            copy_nv12_pitched(&src, w, h, &mut dst[..20], pitch).is_err(),
            "short dst"
        );
    }
}
