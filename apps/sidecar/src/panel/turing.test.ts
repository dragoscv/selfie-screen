import { describe, expect, it } from "vitest";

import { PANEL_HEIGHT, PANEL_WIDTH, toRgb565 } from "./turing.js";

function frame(fill: [number, number, number]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(PANEL_WIDTH * PANEL_HEIGHT * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = fill[0];
        out[i + 1] = fill[1];
        out[i + 2] = fill[2];
        out[i + 3] = 255;
    }
    return out;
}

describe("toRgb565", () => {
    it("produces one 16-bit word per pixel", () => {
        expect(toRgb565(frame([0, 0, 0]))).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
    });

    it("packs pure black and pure white at the extremes", () => {
        expect(toRgb565(frame([0, 0, 0]))[0]).toBe(0x0000);
        expect(toRgb565(frame([255, 255, 255]))[0]).toBe(0xffff);
    });

    it("packs channels into 5-6-5 bit fields", () => {
        // Red only: all five red bits set, green and blue clear.
        expect(toRgb565(frame([255, 0, 0]))[0]).toBe(0xf800);
        // Green only: all six green bits set.
        expect(toRgb565(frame([0, 255, 0]))[0]).toBe(0x07e0);
        // Blue only: all five blue bits set.
        expect(toRgb565(frame([0, 0, 255]))[0]).toBe(0x001f);
    });

    it("truncates low bits rather than rounding", () => {
        // Red keeps the top 5 bits: 0x07 = 0b00000111 is entirely below them.
        expect(toRgb565(frame([0x07, 0x00, 0x00]))[0]).toBe(0x0000);
        // 0x08 survives as the least significant red bit -> 1 << 11.
        expect(toRgb565(frame([0x08, 0x00, 0x00]))[0]).toBe(0x0800);
        // Blue keeps the top 5 bits too: 0x07 truncates away entirely.
        expect(toRgb565(frame([0x00, 0x00, 0x07]))[0]).toBe(0x0000);
        // Green keeps 6 bits, so it resolves finer than red or blue.
        expect(toRgb565(frame([0x00, 0x04, 0x00]))[0]).toBe(0x0020);
    });

    it("reproduces the brand background colour", () => {
        // #0B0E14 -> r=0x0B g=0x0E b=0x14
        const expected = ((0x0b & 0xf8) << 8) | ((0x0e & 0xfc) << 3) | (0x14 >> 3);
        expect(toRgb565(frame([0x0b, 0x0e, 0x14]))[0]).toBe(expected);
    });

    it("ignores the alpha channel", () => {
        const opaque = frame([120, 130, 140]);
        const transparent = frame([120, 130, 140]);
        for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
        expect(toRgb565(opaque)[0]).toBe(toRgb565(transparent)[0]);
    });
});
