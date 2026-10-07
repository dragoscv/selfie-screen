import { captionsSchema } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { EDGE_SAFE, captionLook, charsPerLine, clampCentre, wrapCaption } from "./caption-draw.js";

describe("caption layout", () => {
    it("defaults sit between the face and TikTok's comment area, off by default", () => {
        const c = captionsSchema.parse({});
        expect(c.output).toBe(false);
        expect(c.translate).toBe(false);
        expect(c.u).toBe(0.5);
        // Portrait: top bar ends at v 0.12, comments start at v 0.6.
        expect(c.v).toBeGreaterThan(0.12);
        expect(c.v).toBeLessThan(0.6);
    });

    it("keeps the strip inside the frame however far it is dragged", () => {
        const p = clampCentre(1.4, -0.3, 0.5, 0.08);
        expect(p.u + 0.25).toBeLessThanOrEqual(1 - EDGE_SAFE + 1e-9);
        expect(p.v - 0.04).toBeGreaterThanOrEqual(EDGE_SAFE - 1e-9);
        // A strip wider than the frame stays centred.
        expect(clampCentre(0.1, 0.5, 1.2, 0.1).u).toBeCloseTo(0.5, 9);
    });

    it("wraps long sentences to two lines and history to one", () => {
        const long = "Salut tuturor, mulțumesc că sunteți aici în seara asta, avem multe surprize pentru voi";
        const w = wrapCaption({ history: [long], main: long, translated: "" }, 30);
        expect(w.main.length).toBe(2);
        expect(w.history.length).toBe(1);
        expect(w.translated).toEqual([]);
    });

    it("a wider frame fits more characters per line, a bigger scale fewer", () => {
        expect(charsPerLine(16 / 9, 1)).toBeGreaterThan(charsPerLine(9 / 16, 1));
        expect(charsPerLine(9 / 16, 2)).toBeLessThan(charsPerLine(9 / 16, 1));
    });

    it("minimal style has no pill but shadowed text", () => {
        const m = captionLook("minimal");
        expect(m.bg).toBe("rgba(0,0,0,0)");
        expect(m.shadow).toBe(true);
    });
});
