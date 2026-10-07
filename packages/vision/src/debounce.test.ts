import type { SignalEvent, SignalId, Subject } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { defaultSignalConfig, gestureOverrides, SignalTracker } from "./debounce.js";

const OWNER: Subject = { kind: "person", track: 1, owner: true };
const GUEST: Subject = { kind: "person", track: 2, owner: false };

/** Feed `score` for `signal` every 33 ms from t0 for ms; returns events. */
function feed(tr: SignalTracker, signal: SignalId, score: number, t0: number, ms: number, subject = OWNER): SignalEvent[] {
    const out: SignalEvent[] = [];
    for (let t = t0; t < t0 + ms; t += 33) out.push(...tr.update(subject, score > 0 ? [{ signal, score }] : [], [], t));
    return out;
}

const tracker = () => new SignalTracker({ overrides: { smile: { minOnMs: 200, minOffMs: 250, cooldownMs: 1000 } } });

describe("calibrated gesture thresholds", () => {
    it("maps hands.gestures to on/off overrides, ignoring unknown names", () => {
        const o = gestureOverrides({ fist: 0.64, bogus: 0.5, victory: Number.NaN }, ["fist", "victory"]);
        expect(Object.keys(o)).toEqual(["fist"]);
        expect(o.fist?.on).toBe(0.64);
        expect(o.fist?.off).toBeLessThan(0.64);
        expect(o.fist?.off).toBeCloseTo(0.64 * 0.7);
    });

    it("a stricter personal threshold blocks a score the default would accept", () => {
        const tr = new SignalTracker();
        expect(feed(tr, "fist", 0.55, 0, 600).map((e) => e.phase)).toEqual(["start"]);
        const strict = new SignalTracker();
        strict.setOverrides(gestureOverrides({ fist: 0.7 }, ["fist"]));
        expect(feed(strict, "fist", 0.55, 0, 600)).toEqual([]);
        expect(feed(strict, "fist", 0.8, 600, 600).map((e) => e.phase)).toEqual(["start"]);
    });
});

describe("SignalTracker edges", () => {
    it("emits start after the dwell and end with the duration", () => {
        const tr = tracker();
        const on = feed(tr, "smile", 0.9, 0, 1000);
        expect(on.map((e) => e.phase)).toEqual(["start"]);
        expect(on[0]?.at).toBeGreaterThanOrEqual(200);
        const off = feed(tr, "smile", 0, 1000, 600);
        expect(off.map((e) => e.phase)).toEqual(["end"]);
        expect(off[0]?.durationMs).toBeGreaterThan(700);
        expect(off[0]?.durationMs).toBeLessThan(1000);
    });

    it("ignores blips shorter than the dwell", () => {
        const tr = tracker();
        expect([...feed(tr, "smile", 0.9, 0, 120), ...feed(tr, "smile", 0, 120, 500)]).toEqual([]);
    });

    it("holds through short dropouts (release dwell) and hysteresis", () => {
        const tr = tracker();
        feed(tr, "smile", 0.9, 0, 500);
        const mid = [...feed(tr, "smile", 0, 500, 150), ...feed(tr, "smile", 0.4, 650, 500), ...feed(tr, "smile", 0.9, 1150, 300)];
        // 0.4 is between off (0.35) and on (0.5): stays on.
        expect(mid).toEqual([]);
    });

    it("respects the cooldown before a new start", () => {
        const tr = tracker();
        feed(tr, "smile", 0.9, 0, 500);
        feed(tr, "smile", 0, 500, 400);
        expect(feed(tr, "smile", 0.9, 900, 500)).toEqual([]);
        // After the cooldown has elapsed a new start is allowed.
        feed(tr, "smile", 0, 1400, 100);
        expect(feed(tr, "smile", 0.9, 1900, 500).map((e) => e.phase)).toEqual(["start"]);
    });

    it("turns momentary levels into a single pulse", () => {
        const tr = new SignalTracker();
        const ev = feed(tr, "nod", 0.9, 0, 500);
        expect(ev.map((e) => e.phase)).toEqual(["pulse"]);
    });

    it("rate-limits explicit pulses by cooldown", () => {
        const tr = new SignalTracker();
        const p = (t: number) => tr.update(OWNER, [], [{ signal: "wink_left", confidence: 0.9 }], t);
        expect(p(0)).toHaveLength(1);
        expect(p(200)).toHaveLength(0);
        expect(p(700)).toHaveLength(1);
    });

    it("keeps hands and subjects apart", () => {
        const tr = new SignalTracker();
        const out: SignalEvent[] = [];
        for (let t = 0; t < 600; t += 33) {
            out.push(...tr.update(OWNER, [{ signal: "fist", score: 0.9, hand: "left" }, { signal: "fist", score: 0.9, hand: "right" }], [], t));
            out.push(...tr.update(GUEST, [{ signal: "fist", score: 0.9, hand: "left" }], [], t));
        }
        expect(out.filter((e) => e.phase === "start")).toHaveLength(3);
        expect(new Set(out.map((e) => `${e.subject.track}${e.hand}`))).toEqual(new Set(["1left", "1right", "2left"]));
    });

    it("ends every active state when the subject leaves", () => {
        const tr = new SignalTracker();
        feed(tr, "fist", 0.9, 0, 600);
        expect(tr.active(1)).toEqual(["fist"]);
        const ev = tr.leave(1, 700);
        expect(ev.map((e) => [e.signal, e.phase])).toEqual([["fist", "end"]]);
        expect(tr.active(1)).toEqual([]);
    });

    it("uses long dwell defaults for posture (slouch 60 s)", () => {
        expect(defaultSignalConfig("slouch").minOnMs).toBe(60_000);
        expect(defaultSignalConfig("fist").minOnMs).toBeLessThan(500);
    });
});

describe("hold progress and arming", () => {
    it("reports hold progress towards a rule's hold target", () => {
        const tr = new SignalTracker();
        tr.setHoldTargets({ i_love_you: 600 });
        feed(tr, "i_love_you", 0.9, 0, 330);
        const h = tr.holds(330).find((x) => x.signal === "i_love_you");
        expect(h?.progress).toBeGreaterThan(0.4);
        expect(h?.progress).toBeLessThan(0.7);
        feed(tr, "i_love_you", 0.9, 330, 400);
        expect(tr.holds(730).find((x) => x.signal === "i_love_you")?.progress).toBe(1);
    });

    it("arms after holding an open palm for armHoldMs, for armWindowMs", () => {
        const tr = new SignalTracker({ armHoldMs: 1000, armWindowMs: 5000 });
        feed(tr, "open_palm", 0.9, 0, 700);
        expect(tr.isArmed(700)).toBe(false);
        feed(tr, "open_palm", 0.9, 700, 500);
        expect(tr.isArmed(1200)).toBe(true);
        expect(tr.isArmed(5900)).toBe(true);
        expect(tr.isArmed(6300)).toBe(false);
    });

    it("needs the palm to be released and held again to re-arm", () => {
        const tr = new SignalTracker({ armHoldMs: 500, armWindowMs: 1000 });
        feed(tr, "open_palm", 0.9, 0, 3000);
        expect(tr.isArmed(2900)).toBe(false);
        feed(tr, "open_palm", 0, 3000, 100);
        feed(tr, "open_palm", 0.9, 3100, 700);
        expect(tr.isArmed(3800)).toBe(true);
    });

    it("only the owner can arm", () => {
        const tr = new SignalTracker({ armHoldMs: 300 });
        feed(tr, "open_palm", 0.9, 0, 1000, GUEST);
        expect(tr.isArmed(1000)).toBe(false);
    });
});
