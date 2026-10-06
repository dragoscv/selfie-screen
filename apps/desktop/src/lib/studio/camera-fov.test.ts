import { describe, expect, it } from "vitest";
import { studioSchema } from "@tiksee/core";

import { cameraVfov, uprightVfov } from "./camera-fov.js";

describe("cameraVfov", () => {
    it("uses the lens preset while the FOV source is the preset (a stale stored 60 is ignored)", () => {
        const s = studioSchema.parse({ vfovDeg: 60, cameraPreset: "sony-zv-e10", lensMm: 16 });
        expect(cameraVfov(s)).toBeCloseTo(44.8, 0);
    });

    it("keeps a measured value", () => {
        const s = studioSchema.parse({ vfovDeg: 50, cameraPreset: "custom", space: { fovSource: "charuco" } });
        expect(cameraVfov(s)).toBe(50);
    });
});

describe("uprightVfov", () => {
    it("widens to the raw width for a camera mounted on its side", () => {
        // 1920x1080 sensor at 45 deg over its 1080 height, rotated 90: the upright height is 1920 px.
        expect(uprightVfov(45, 90, 1920, 1080)).toBeCloseTo(72.7, 0);
        expect(uprightVfov(45, 0, 1920, 1080)).toBe(45);
    });
});
