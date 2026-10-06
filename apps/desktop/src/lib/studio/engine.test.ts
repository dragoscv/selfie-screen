import type { ChatEvent } from "@tiksee/core";
import { ShoulderTracker, coverFraming, cropFraming, type Landmark } from "@tiksee/pets";
import { describe, expect, it } from "vitest";

import type { FaceBox } from "./controller.js";
import { anchorsInOutput, boxToOutput, depthAt, faceToOutput, ownerFace, petEventFor, pickCamera, syntheticFrame } from "./engine.js";

const cam = (deviceId: string, label: string): MediaDeviceInfo =>
    ({ deviceId, label, kind: "videoinput", groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;

const chat = (over: Partial<ChatEvent>): ChatEvent => ({
    id: "1",
    kind: "chat",
    user: { id: "u", uniqueId: "u", nickname: "U" },
    text: "",
    at: 0,
    streamId: "main",
    ...over,
});

describe("pickCamera", () => {
    const list = [cam("a", "Integrated Camera"), cam("b", "USB3.0 Video"), { ...cam("m", "mic"), kind: "audioinput" } as MediaDeviceInfo];

    it("prefers the explicit device, then the USB3.0 capture card, then the first camera", () => {
        expect(pickCamera(list, "a")?.deviceId).toBe("a");
        expect(pickCamera(list, "")?.deviceId).toBe("b");
        expect(pickCamera(list, "gone")?.deviceId).toBe("b");
        expect(pickCamera([cam("a", "Integrated Camera")], "")?.deviceId).toBe("a");
        expect(pickCamera([], "")).toBeUndefined();
    });
});

describe("petEventFor", () => {
    it("maps gifts by total value and chat commands to clips", () => {
        expect(petEventFor(chat({ kind: "gift", giftDiamonds: 1, giftCount: 5 }))).toEqual({ type: "gift", tier: "small" });
        expect(petEventFor(chat({ kind: "gift", giftDiamonds: 50, giftCount: 2 }))).toEqual({ type: "gift", tier: "big" });
        expect(petEventFor(chat({ text: "!pet dance" }))).toEqual({ type: "command", clip: "dance" });
        expect(petEventFor(chat({ text: "!PET Jump" }))).toEqual({ type: "command", clip: "react" });
        expect(petEventFor(chat({ text: "salut" }))).toEqual({ type: "chat" });
        expect(petEventFor(chat({ kind: "like" }))).toBeNull();
    });
});

describe("anchorsInOutput", () => {
    const pose = (lx: number, rx: number): Landmark[] => {
        const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
        lm[11] = { x: lx, y: 0.7, visibility: 0.95 };
        lm[12] = { x: rx, y: 0.7, visibility: 0.95 };
        return lm;
    };

    it("maps shoulders from a 16:9 camera into the cropped portrait frame", () => {
        const a = anchorsInOutput(new ShoulderTracker(), pose(0.6, 0.4), 1920, 1080, 1080, 1920, false, 0);
        expect(a).not.toBeNull();
        if (!a) return;
        // 0.2 of camera width spans 0.2 / (9/16 / 16*9...) of the cropped width: wider than 0.2 of output.
        expect(a.left.span).toBeGreaterThan(0.2 * 1080);
        expect(a.left.x).toBeGreaterThan(540);
        expect(a.right.x).toBeLessThan(540);
    });

    it("swaps sides on screen when mirrored", () => {
        const a = anchorsInOutput(new ShoulderTracker(), pose(0.6, 0.4), 1920, 1080, 1920, 1080, true, 0);
        expect(a?.left.x).toBeLessThan(960);
        expect(a?.right.x).toBeGreaterThan(960);
    });

    it("follows the digital crop: 2x zoom doubles the shoulder span", () => {
        const base = coverFraming(1920, 1080, 1080, 1920, false);
        const plain = anchorsInOutput(new ShoulderTracker(), pose(0.55, 0.45), 1920, 1080, 1080, 1920, false, 0, 0, base);
        const zoomed = anchorsInOutput(new ShoulderTracker(), pose(0.55, 0.45), 1920, 1080, 1080, 1920, false, 0, 0, cropFraming(base, 2, 0.5, 0.5));
        expect(zoomed?.left.span).toBeCloseTo((plain?.left.span ?? 0) * 2, 3);
    });
});

describe("output mapping", () => {
    const face = (over: Partial<FaceBox>): FaceBox => ({
        x: 0.45,
        y: 0.2,
        w: 0.1,
        h: 0.2,
        leftEye: [0.47, 0.28],
        rightEye: [0.53, 0.28],
        rollDeg: 0,
        track: 1,
        owner: false,
        ...over,
    });

    it("maps a raw face box into the cropped, mirrored portrait output", () => {
        const f = coverFraming(1920, 1080, 1080, 1920, true);
        const out = faceToOutput(f, 0, face({}));
        // Centred face stays centred; widths grow by the crop factor (1 / scaleX).
        expect(out.x + out.w / 2).toBeCloseTo(0.5, 6);
        expect(out.w).toBeCloseTo(0.1 / f.scaleX, 6);
        expect(out.h).toBeCloseTo(0.2, 6);
        expect(out.rollDeg).toBeCloseTo(0, 6);
    });

    it("rotates boxes for a sideways camera (90°)", () => {
        const f = coverFraming(1080, 1920, 1080, 1920, false);
        const b = boxToOutput(f, 90, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
        // rawToUpright(90): (x, y) -> (1 - y, x)
        expect(b).toMatchObject({ x: expect.closeTo(0.4, 6), y: expect.closeTo(0.1, 6), w: expect.closeTo(0.4, 6), h: expect.closeTo(0.3, 6) });
    });

    it("picks the flagged owner, else the largest face", () => {
        const a = face({ w: 0.1, h: 0.1, track: 1 });
        const b = face({ w: 0.2, h: 0.2, track: 2 });
        expect(ownerFace([a, b])?.track).toBe(2);
        expect(ownerFace([a, { ...b, owner: false }, { ...a, track: 3, owner: true }])?.track).toBe(3);
        expect(ownerFace([])).toBeUndefined();
    });

    it("samples the depth map at a raw point", () => {
        const d = { data: new Float32Array([0, 0.25, 0.5, 1]), width: 2, height: 2 };
        expect(depthAt(d, 0, 0)).toBe(0);
        expect(depthAt(d, 1, 1)).toBe(1);
        expect(depthAt(d, 0.9, 0.1)).toBe(0.25);
    });

    it("synthetic bench frame has an owner face, shoulders and a distance", () => {
        const fr = syntheticFrame(1000);
        expect(fr.faces[0]?.owner).toBe(true);
        expect(fr.poses[0]?.[11]?.visibility).toBeGreaterThan(0.9);
        expect(fr.ownerDistanceM).toBe(1);
    });
});
