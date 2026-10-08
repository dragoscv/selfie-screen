/**
 * Lip colour from a hue 0..1 (0 = red): a natural, slightly muted rose/berry palette, not a
 * fully saturated colour wheel (sRGB-ish 0..1, multiplied by luminance in the shader).
 */
export function lipColor(hue: number): [number, number, number] {
    const h = (((hue % 1) + 1) % 1) * 6;
    const s = 0.55;
    const v = 0.78;
    const c = v * s;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = v - c;
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
}
