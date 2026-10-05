import type { ChatEvent } from "@tiksee/core";
import { ShoulderTracker, type Landmark } from "@tiksee/pets";
import { describe, expect, it } from "vitest";

import { anchorsInOutput, petEventFor, pickCamera } from "./engine.js";

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
});
