import { visionSchema, type SignalEvent } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { ZoneGate, handCentre, inGateZone } from "./zone-gate.js";

const zones = visionSchema.parse({}).gestureZones;
const ev = (signal: SignalEvent["signal"], phase: SignalEvent["phase"], hand?: "left" | "right", owner = true): SignalEvent => ({
    signal,
    phase,
    at: 0,
    confidence: 0.9,
    subject: { kind: "person", track: 0, owner },
    ...(hand ? { hand } : {}),
});

describe("gesture safe-zone gate", () => {
    it("knows the portrait zones and leaves the middle of the frame free", () => {
        expect(inGateZone(0.3, 0.75, "portrait", zones)).toBe(true); // comments
        expect(inGateZone(0.95, 0.75, "portrait", zones)).toBe(true); // likes rail
        expect(inGateZone(0.5, 0.05, "portrait", zones)).toBe(true); // top bar
        expect(inGateZone(0.5, 0.45, "portrait", zones)).toBe(false);
        // Side crop is off by default.
        expect(inGateZone(0.03, 0.4, "portrait", zones)).toBe(false);
        expect(inGateZone(0.03, 0.4, "portrait", { ...zones, zones: { ...zones.zones, crop: true } })).toBe(true);
        expect(inGateZone(0.3, 0.75, "portrait", { ...zones, enabled: false })).toBe(false);
        expect(inGateZone(0.3, 0.75, "portrait", { ...zones, zones: { ...zones.zones, comments: false } })).toBe(false);
    });

    it("landscape blocks only outside the title-safe area, when chosen", () => {
        const on = { ...zones, zones: { ...zones.zones, title: true } };
        expect(inGateZone(0.02, 0.5, "landscape", zones)).toBe(false);
        expect(inGateZone(0.02, 0.5, "landscape", on)).toBe(true);
        expect(inGateZone(0.5, 0.5, "landscape", on)).toBe(false);
    });

    it("drops a hand-gesture start from a hand in a zone, and its end", () => {
        const g = new ZoneGate();
        expect(g.filter([ev("thumb_up", "start", "left")], { left: true }, true)).toEqual([]);
        // The hand leaves the zone before the gesture ends: the orphan end is still dropped.
        expect(g.filter([ev("thumb_up", "end", "left")], {}, true)).toEqual([]);
    });

    it("lets the other hand, other subjects and non-hand signals through", () => {
        const g = new ZoneGate();
        expect(g.filter([ev("thumb_up", "start", "right")], { left: true }, true)).toHaveLength(1);
        expect(g.filter([ev("smile", "start")], { left: true, right: true }, true)).toHaveLength(1);
        expect(g.filter([ev("thumb_up", "start", "left", false)], { left: true }, true)).toHaveLength(1);
    });

    it("two-hand gestures are blocked when either hand is in a zone; pulses too", () => {
        const g = new ZoneGate();
        expect(g.filter([ev("heart", "start")], { right: true }, true)).toEqual([]);
        expect(g.filter([ev("clap", "pulse")], { left: true }, true)).toEqual([]);
    });

    it("a gesture started outside keeps going when the hand drifts in", () => {
        const g = new ZoneGate();
        expect(g.filter([ev("open_palm", "start", "left")], {}, true)).toHaveLength(1);
        expect(g.filter([ev("open_palm", "end", "left")], { left: true }, true)).toHaveLength(1);
    });

    it("off = everything passes", () => {
        expect(new ZoneGate().filter([ev("thumb_up", "start", "left")], { left: true }, false)).toHaveLength(1);
    });

    it("hand centre is the landmark mean", () => {
        expect(handCentre([{ x: 0, y: 0 }, { x: 1, y: 0.5 }])).toEqual({ x: 0.5, y: 0.25 });
        expect(handCentre([])).toBeNull();
    });
});
