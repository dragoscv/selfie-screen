//! The "TikSee — camera offline" frame the camera shows while no producer is
//! publishing: brand background, the wordmark, an accent bar and a caption.
//! Drawn with a built-in 5x7 bitmap font so the DLL needs no font files
//! (the Frame Server runs it in session 0 as LocalService).

use crate::layout::{FrameError, check_dims, nv12_len};
use crate::nv12::rgba_to_nv12;

pub const BACKGROUND: [u8; 3] = [16, 18, 26];
pub const ACCENT: [u8; 3] = [254, 44, 85];
pub const TITLE_COLOUR: [u8; 3] = [240, 242, 248];
pub const CAPTION_COLOUR: [u8; 3] = [150, 156, 172];
pub const TITLE: &str = "TIKSEE";
pub const CAPTION: &str = "CAMERA OFFLINE";

const GLYPH_W: usize = 5;
const GLYPH_H: usize = 7;
/// Glyph advance in font cells: 5 columns of ink plus 1 of spacing.
const ADVANCE: usize = GLYPH_W + 1;

/// Rows top to bottom; bit 4 is the leftmost column.
fn glyph(c: char) -> [u8; GLYPH_H] {
    match c {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        _ => [0; GLYPH_H],
    }
}

/// Where a line of text lands: top-left pixel and the size of one font cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextBox {
    pub x: usize,
    pub y: usize,
    pub cell: usize,
}

impl TextBox {
    pub const fn width(&self, text: &str) -> usize {
        (text.len() * ADVANCE - 1) * self.cell
    }

    pub const fn height(&self) -> usize {
        GLYPH_H * self.cell
    }
}

fn centred(width: usize, height: usize, text: &str, cell: usize, centre_y_permille: usize) -> TextBox {
    let cell = cell.max(1);
    let text_w = (text.len() * ADVANCE - 1) * cell;
    let text_h = GLYPH_H * cell;
    TextBox {
        x: width.saturating_sub(text_w) / 2,
        y: (height * centre_y_permille / 1000).saturating_sub(text_h / 2),
        cell,
    }
}

/// Layout of the wordmark, scaled to the short edge.
pub fn title_box(width: u32, height: u32) -> TextBox {
    let short = width.min(height) as usize;
    centred(width as usize, height as usize, TITLE, short / 40, 420)
}

pub fn caption_box(width: u32, height: u32) -> TextBox {
    let short = width.min(height) as usize;
    centred(width as usize, height as usize, CAPTION, short / 90, 620)
}

struct Canvas<'a> {
    rgba: &'a mut [u8],
    width: usize,
    height: usize,
}

impl Canvas<'_> {
    fn rect(&mut self, x: usize, y: usize, w: usize, h: usize, rgb: [u8; 3]) {
        for row in y..(y + h).min(self.height) {
            let start = (row * self.width + x.min(self.width)) * 4;
            let end = (row * self.width + (x + w).min(self.width)) * 4;
            for px in self.rgba[start..end].as_chunks_mut::<4>().0 {
                *px = [rgb[0], rgb[1], rgb[2], 255];
            }
        }
    }

    fn text(&mut self, text: &str, at: TextBox, rgb: [u8; 3]) {
        for (i, c) in text.chars().enumerate() {
            let left = at.x + i * ADVANCE * at.cell;
            for (row, bits) in glyph(c).into_iter().enumerate() {
                for col in 0..GLYPH_W {
                    if bits & (0x10 >> col) != 0 {
                        self.rect(left + col * at.cell, at.y + row * at.cell, at.cell, at.cell, rgb);
                    }
                }
            }
        }
    }
}

pub fn render_rgba(width: u32, height: u32) -> Result<Vec<u8>, FrameError> {
    check_dims(width, height)?;
    let (w, h) = (width as usize, height as usize);
    let mut rgba = vec![0; w * h * 4];
    let mut canvas = Canvas {
        rgba: &mut rgba,
        width: w,
        height: h,
    };
    canvas.rect(0, 0, w, h, BACKGROUND);
    let title = title_box(width, height);
    canvas.text(TITLE, title, TITLE_COLOUR);
    let bar_w = title.width(TITLE) / 3;
    let bar_y = title.y + title.height() + title.cell * 2;
    canvas.rect((w - bar_w) / 2, bar_y, bar_w, title.cell.max(2), ACCENT);
    canvas.text(CAPTION, caption_box(width, height), CAPTION_COLOUR);
    Ok(rgba)
}

pub fn render_nv12(width: u32, height: u32) -> Result<Vec<u8>, FrameError> {
    let rgba = render_rgba(width, height)?;
    let mut out = vec![0; nv12_len(width, height)];
    rgba_to_nv12(&rgba, width, height, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nv12::yuv;

    fn pixel(rgba: &[u8], width: u32, x: usize, y: usize) -> [u8; 3] {
        let i = (y * width as usize + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2]]
    }

    #[test]
    fn every_glyph_in_the_strings_has_ink() {
        for c in TITLE.chars().chain(CAPTION.chars()).filter(|c| *c != ' ') {
            assert!(glyph(c).iter().any(|row| *row != 0), "missing glyph {c}");
        }
    }

    #[test]
    fn both_orientations_place_text_inside_the_frame() {
        for (w, h) in [(1920, 1080), (1080, 1920)] {
            let title = title_box(w, h);
            let caption = caption_box(w, h);
            assert!(title.x + title.width(TITLE) <= w as usize);
            assert!(caption.x + caption.width(CAPTION) <= w as usize);
            assert!(title.y + title.height() < caption.y, "{w}x{h}: title above caption");
            assert!(caption.y + caption.height() <= h as usize);
        }
    }

    #[test]
    fn frame_shows_background_wordmark_and_caption() {
        let (w, h) = (1920, 1080);
        let rgba = render_rgba(w, h).expect("render");
        assert_eq!(pixel(&rgba, w, 0, 0), BACKGROUND);
        assert_eq!(pixel(&rgba, w, w as usize - 1, h as usize - 1), BACKGROUND);
        // Top-left cell of the T in TIKSEE is ink.
        let title = title_box(w, h);
        assert_eq!(
            pixel(&rgba, w, title.x + title.cell / 2, title.y + title.cell / 2),
            TITLE_COLOUR
        );
        // Top-left cell of the C in CAMERA is blank (C starts at column 1).
        let caption = caption_box(w, h);
        assert_eq!(pixel(&rgba, w, caption.x, caption.y), BACKGROUND);
        assert_eq!(
            pixel(&rgba, w, caption.x + caption.cell + 1, caption.y + 1),
            CAPTION_COLOUR
        );
    }

    #[test]
    fn nv12_version_matches_the_rgba_colours() {
        let (w, h) = (1080, 1920);
        let frame = render_nv12(w, h).expect("render");
        assert_eq!(frame.len(), nv12_len(w, h));
        let (bg_y, bg_u, bg_v) = yuv(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2]);
        assert_eq!(frame[0], bg_y);
        let uv = (w * h) as usize;
        assert_eq!(&frame[uv..uv + 2], &[bg_u, bg_v]);
        let title = title_box(w, h);
        let ink = (title.y + title.cell / 2) * w as usize + title.x + title.cell / 2;
        assert_eq!(frame[ink], yuv(TITLE_COLOUR[0], TITLE_COLOUR[1], TITLE_COLOUR[2]).0);
    }

    #[test]
    fn odd_sizes_are_rejected() {
        assert!(render_nv12(1919, 1080).is_err());
    }
}
