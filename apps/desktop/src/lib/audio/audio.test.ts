import { describe, expect, it } from "vitest";

import { isValidAccelerator } from "../hotkeys.js";
import { StreamResampler, bytesToBase64, createPcm16Decoder, floatToPcm16 } from "./pcm.js";
import { createSseParser, type SseEvent } from "./sse.js";
import { EnergyVad } from "./vad.js";

function pcmBase64(samples: number[]): string {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((s, i) => view.setInt16(i * 2, s, true));
    return bytesToBase64(bytes);
}

describe("PCM16 decoder", () => {
    it("decodes little-endian samples to floats", () => {
        const out = createPcm16Decoder().decode(pcmBase64([0, 16384, -32768]));
        expect(Array.from(out)).toEqual([0, 0.5, -1]);
    });

    it("carries an odd trailing byte into the next chunk instead of shifting samples", () => {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt16(0, 1000, true);
        new DataView(bytes.buffer).setInt16(2, -1000, true);
        const decoder = createPcm16Decoder();
        const first = decoder.decode(bytesToBase64(bytes.subarray(0, 3)));
        const second = decoder.decode(bytesToBase64(bytes.subarray(3)));
        expect(Array.from(first).map((s) => Math.round(s * 32768))).toEqual([1000]);
        expect(Array.from(second).map((s) => Math.round(s * 32768))).toEqual([-1000]);
    });

    it("round-trips through floatToPcm16 with clamping", () => {
        expect(Array.from(floatToPcm16(new Float32Array([2, -2, 0])))).toEqual([32767, -32768, 0]);
    });
});

describe("StreamResampler", () => {
    it("produces the right number of samples across blocks (48 kHz → 24 kHz)", () => {
        const resampler = new StreamResampler(48_000, 24_000);
        let total = 0;
        for (let i = 0; i < 100; i++) total += resampler.push(new Float32Array(128).fill(0.25)).length;
        expect(Math.abs(total - 6400)).toBeLessThanOrEqual(1);
    });

    it("keeps a constant signal constant", () => {
        const out = new StreamResampler(44_100, 24_000).push(new Float32Array(441).fill(0.5));
        expect(out.every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    });
});

describe("SSE parser", () => {
    it("parses events split across chunks and CRLF boundaries", () => {
        const events: SseEvent[] = [];
        const parser = createSseParser((e) => events.push(e));
        parser.feed('event: start\r\ndata: {"sample_rate":24000}\r');
        parser.feed("\n\r\nevent: audio\ndata: {\"delta\":\"AA");
        parser.feed('AA"}\n\n: comment\n\nevent: done\ndata: {}');
        parser.flush();
        expect(events).toEqual([
            { event: "start", data: '{"sample_rate":24000}' },
            { event: "audio", data: '{"delta":"AAAA"}' },
            { event: "done", data: "{}" },
        ]);
    });

    it("defaults the event name to message and joins multi-line data", () => {
        const events: SseEvent[] = [];
        const parser = createSseParser((e) => events.push(e));
        parser.feed("data: a\ndata: b\n\n");
        expect(events).toEqual([{ event: "message", data: "a\nb" }]);
    });
});

describe("EnergyVad", () => {
    it("detects speech above the floor and releases after the hangover", () => {
        const vad = new EnergyVad({ hangoverMs: 300 });
        for (let t = 0; t < 1000; t += 40) vad.update(0.003, t);
        expect(vad.update(0.2, 1000)).toBe(true);
        expect(vad.update(0.002, 1200)).toBe(true);
        expect(vad.update(0.002, 1400)).toBe(false);
    });
});

describe("accelerator validation", () => {
    it.each([
        ["", true],
        ["CommandOrControl+Shift+M", true],
        ["Ctrl+F5", true],
        ["Ctrl+Shift", false],
        ["Ctrl++", false],
        ["Banana+M", false],
    ])("%s → %s", (value, valid) => {
        expect(isValidAccelerator(value)).toBe(valid);
    });
});
